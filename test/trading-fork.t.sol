// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "../../contracts/lib/forge-std/src/Test.sol";

interface TradingToken {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
}
interface PinnedTradingRouter {
    struct Key { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    function swap(Key calldata, bool, uint256, uint256, address) external returns (uint256);
    function poolManager() external view returns (address);
}

/// Local fork only. The existing fixture calldata creates isolated test launches, not listings.
contract PluggedTradingForkTest is Test {
    address constant ROUTER = 0xD6EdCd3cc28C40b42d6fe31B054eBb93a944A3A6;
    address constant LAUNCHER = 0xCc491F9962CA5545163ac425210b69e24AC29a96;
    address constant HOOK = 0xdC0244274F0b4E60Ec4433bfA9d3Ff0632CAa0Cc;
    address constant CREATOR = 0x1111111111111111111111111111111111111111;
    string fixture;
    function setUp() public {
        // Explicit pin mandatory; absence fails, never silently skips network verification.
        uint256 pin = vm.envUint("TRADING_FORK_BLOCK");
        vm.createSelectFork(vm.envOr("PLUGGED_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")), pin);
        fixture = vm.readFile("../artifacts/carbon-fork-fixtures.json");
        assertEq(block.chainid, 4663);
        assertEq(ROUTER.codehash, 0x67867a85f9694ba856fa05c374f588fb2b293127c5576424d7e35dc09f9b3246);
        assertEq(PinnedTradingRouter(ROUTER).poolManager(), 0x8366a39CC670B4001A1121B8F6A443A643e40951);
    }
    function setupPool(string memory symbol) internal returns (address token, address pair, uint256 buy, PinnedTradingRouter.Key memory key) {
        string memory prefix = string.concat(".",symbol);
        pair = vm.parseJsonAddress(fixture,string.concat(prefix,".quote"));
        buy = vm.parseUint(vm.parseJsonString(fixture,string.concat(prefix,".buy")));
        bytes memory setup = vm.parseJsonBytes(fixture,string.concat(prefix,".setup"));
        if (setup.length > 0) {
            vm.prank(vm.parseJsonAddress(fixture,string.concat(prefix,".owner")));
            (bool approved,) = address(0xDFf0A6FfD11Eb1494E8A57DD5eF92b23122BaeC0).call(setup);
            assertTrue(approved,"local-fork registry approval");
        }
        deal(pair, CREATOR, buy * 10);
        vm.startPrank(CREATOR);
        TradingToken(pair).approve(LAUNCHER,buy);
        (bool ok,bytes memory result)=LAUNCHER.call(vm.parseJsonBytes(fixture,string.concat(prefix,".calldata")));
        if (!ok) assembly { revert(add(result,32),mload(result)) }
        bytes32 poolId;
        (token,poolId)=abi.decode(result,(address,bytes32));
        bool first=token<pair;
        key=PinnedTradingRouter.Key(first?token:pair,first?pair:token,0,60,HOOK);
        assertEq(keccak256(abi.encode(key)),poolId);
        vm.stopPrank();
    }
    function exercise(string memory symbol) internal {
        (address token,address pair,uint256 buy,PinnedTradingRouter.Key memory key)=setupPool(symbol);
        vm.startPrank(CREATOR);
        TradingToken(pair).approve(ROUTER,buy);
        uint256 beforeBalance=TradingToken(token).balanceOf(CREATOR);
        uint256 snap=vm.snapshotState();
        uint256 quoted=PinnedTradingRouter(ROUTER).swap(key,pair<token,buy,0,CREATOR);
        assertGt(quoted,0);
        assertTrue(vm.revertToState(snap));
        vm.expectRevert(abi.encodeWithSignature("TooLittleReceived(uint256,uint256)",quoted,quoted+1));
        PinnedTradingRouter(ROUTER).swap(key,pair<token,buy,quoted+1,CREATOR);
        uint256 bought=PinnedTradingRouter(ROUTER).swap(key,pair<token,buy,quoted*9950/10000,CREATOR);
        assertEq(bought,quoted);
        assertEq(TradingToken(token).balanceOf(CREATOR)-beforeBalance,bought);
        assertEq(TradingToken(pair).allowance(CREATOR,ROUTER),0);
        TradingToken(token).approve(ROUTER,bought);
        snap=vm.snapshotState();
        uint256 sellQuote=PinnedTradingRouter(ROUTER).swap(key,token<pair,bought,0,CREATOR);
        assertTrue(vm.revertToState(snap));
        vm.expectRevert(abi.encodeWithSignature("TooLittleReceived(uint256,uint256)",sellQuote,sellQuote+1));
        PinnedTradingRouter(ROUTER).swap(key,token<pair,bought,sellQuote+1,CREATOR);
        uint256 pairBefore=TradingToken(pair).balanceOf(CREATOR);
        uint256 sold=PinnedTradingRouter(ROUTER).swap(key,token<pair,bought,sellQuote*9950/10000,CREATOR);
        assertGt(sold,0);
        assertEq(TradingToken(pair).balanceOf(CREATOR)-pairBefore,sold);
        assertEq(TradingToken(token).balanceOf(ROUTER),0);
        assertEq(TradingToken(pair).balanceOf(ROUTER),0);
        vm.stopPrank();
    }
    function testUSDG6BuySellAndMinimums() public { exercise("USDG"); }
    function testCbBTC8BuySellAndMinimums() public { exercise("cbBTC"); }
    function testWETH18BuySellAndMinimums() public { exercise("WETH"); }
    function testAAPL18BuySellAndMinimums() public { exercise("AAPL"); }
    function testMissingApprovalReverts() public {
        (address token,,uint256 buy,PinnedTradingRouter.Key memory key)=setupPool("USDG");
        vm.prank(CREATOR);vm.expectRevert();
        PinnedTradingRouter(ROUTER).swap(key,key.currency0!=token,buy,1,CREATOR);
    }
    function testSwapHasNoDeadlineAndStillExecutesOneWeekLater() public {
        (address token,address pair,uint256 buy,PinnedTradingRouter.Key memory key)=setupPool("USDG");
        vm.prank(CREATOR);TradingToken(pair).approve(ROUTER,buy);
        bytes memory signedShape=abi.encodeCall(PinnedTradingRouter.swap,(key,pair<token,buy,1,CREATOR));
        vm.warp(block.timestamp+7 days);
        vm.prank(CREATOR);(bool ok,bytes memory result)=ROUTER.call(signedShape);
        assertTrue(ok);assertGt(abi.decode(result,(uint256)),0);
    }
}
