// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface CarbonRouter {
    struct Key {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }
    function swap(Key calldata key, bool zeroForOne, uint256 amountIn, uint256 minimum, address recipient)
        external
        returns (uint256);
}

/// Opt-in pinned-fork tests. No private key and no broadcast operation.
contract CarbonForkTest is Test {
    address constant LAUNCHER = 0xCc491F9962CA5545163ac425210b69e24AC29a96;
    address constant HOOK = 0xdC0244274F0b4E60Ec4433bfA9d3Ff0632CAa0Cc;
    address constant ROUTER = 0xD6EdCd3cc28C40b42d6fe31B054eBb93a944A3A6;
    address constant CREATOR = 0x1111111111111111111111111111111111111111;
    string fixture;
    bool enabled;

    function setUp() public {
        enabled = vm.envOr("PLUGGED_FORK", false);
        if (!enabled) return;
        fixture = vm.readFile("../artifacts/carbon-fork-fixtures.json");
        uint256 blockNumber = vm.parseUint(vm.parseJsonString(fixture, ".blockNumber"));
        vm.createSelectFork(
            vm.envOr("PLUGGED_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")), blockNumber
        );
        assertEq(block.chainid, 4663);
        assertEq(LAUNCHER.codehash, 0x7bea165b15ee48f58180d7865c9026cc37a0b5f7d03d8bbbc172a2bafeb5c135);
    }

    function testFork_USDG6Decimals() public {
        if (!enabled) vm.skip(true);
        exercise("USDG");
    }

    function testFork_WETH18Decimals() public {
        if (!enabled) vm.skip(true);
        exercise("WETH");
    }

    function testFork_CbBTC8Decimals() public {
        if (!enabled) vm.skip(true);
        exercise("cbBTC");
    }

    function testFork_StockAAPL() public {
        if (!enabled) vm.skip(true);
        exercise("AAPL");
    }

    function testFork_NativeEthFunding() public {
        if (!enabled) vm.skip(true);
        address pair = vm.parseJsonAddress(fixture, ".USDG.quote");
        address target = vm.parseJsonAddress(fixture, ".funding.to");
        bytes memory data = vm.parseJsonBytes(fixture, ".funding.data");
        uint256 value = vm.parseUint(vm.parseJsonString(fixture, ".funding.value"));
        uint256 minimum = vm.parseUint(vm.parseJsonString(fixture, ".funding.minimum"));
        deal(CREATOR, 1 ether);
        uint256 beforeBalance = IERC20(pair).balanceOf(CREATOR);
        vm.prank(CREATOR);
        (bool ok, bytes memory result) = target.call{value: value}(data);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
        assertGe(IERC20(pair).balanceOf(CREATOR) - beforeBalance, minimum);
    }

    function exercise(string memory symbol) internal {
        string memory prefix = string.concat(".", symbol);
        address pair = vm.parseJsonAddress(fixture, string.concat(prefix, ".quote"));
        address predicted = vm.parseJsonAddress(fixture, string.concat(prefix, ".token"));
        uint256 buy = vm.parseUint(vm.parseJsonString(fixture, string.concat(prefix, ".buy")));
        bytes memory data = vm.parseJsonBytes(fixture, string.concat(prefix, ".calldata"));
        bytes memory setup = vm.parseJsonBytes(fixture, string.concat(prefix, ".setup"));
        if (setup.length > 0) {
            vm.prank(vm.parseJsonAddress(fixture, string.concat(prefix, ".owner")));
            (bool approved,) = address(0xDFf0A6FfD11Eb1494E8A57DD5eF92b23122BaeC0).call(setup);
            assertTrue(approved, "local-fork-only registry approval");
        }
        deal(pair, CREATOR, buy * 5);
        vm.startPrank(CREATOR);
        IERC20(pair).approve(LAUNCHER, buy);
        (bool ok, bytes memory result) = LAUNCHER.call(data);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
        (address token, bytes32 poolId) = abi.decode(result, (address, bytes32));
        assertEq(token, predicted);
        assertGt(token.code.length, 0);
        assertEq(IERC20(token).totalSupply(), 1_000_000_000 ether);
        uint256 openingReceived = IERC20(token).balanceOf(CREATOR);
        assertGt(openingReceived, 0);
        assertLe(openingReceived, 30_000_000 ether);
        assertEq(IERC20(pair).balanceOf(CREATOR), buy * 4);
        bool tokenFirst = token < pair;
        CarbonRouter.Key memory key =
            CarbonRouter.Key(tokenFirst ? token : pair, tokenFirst ? pair : token, 0, 60, HOOK);
        assertEq(keccak256(abi.encode(key)), poolId);
        IERC20(pair).approve(ROUTER, buy);
        uint256 bought = CarbonRouter(ROUTER).swap(key, !tokenFirst, buy, 1, CREATOR);
        assertGt(bought, 0);
        assertEq(IERC20(token).balanceOf(CREATOR), openingReceived + bought);
        IERC20(token).approve(ROUTER, bought);
        uint256 sold = CarbonRouter(ROUTER).swap(key, tokenFirst, bought, 1, CREATOR);
        assertGt(sold, 0);
        vm.stopPrank();
    }
}
