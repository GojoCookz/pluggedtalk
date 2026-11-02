// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

interface RewardsERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function distributor() external view returns (address);
}

interface RewardsHook {
    struct Key {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }
    function pendingFees(bytes32) external view returns (uint256);
    function pendingTokenFees(bytes32) external view returns (uint256);
    function sweep(Key calldata) external returns (uint256);
    function platformRecipient() external view returns (address);
}

interface RewardsRouter {
    function swap(RewardsHook.Key calldata, bool, uint256, uint256, address) external returns (uint256);
}

interface RewardsDistributor {
    function payoutToken() external view returns (address);
    function totalDistributed() external view returns (uint256);
    function totalWithdrawn() external view returns (uint256);
    function withdrawableOf(address) external view returns (uint256);
    function withdrawnOf(address) external view returns (uint256);
    function shareOf(address) external view returns (uint256);
    function streamFinish() external view returns (uint64);
    function STREAM_WINDOW() external view returns (uint64);
    function withdraw() external returns (uint256);
}

/// Exercises deployed runtime bytecode only. No source-built Carbon substitutes.
contract CarbonRewardsForkTest is Test {
    address constant LAUNCHER = 0xCc491F9962CA5545163ac425210b69e24AC29a96;
    address constant HOOK = 0xdC0244274F0b4E60Ec4433bfA9d3Ff0632CAa0Cc;
    address constant ROUTER = 0xD6EdCd3cc28C40b42d6fe31B054eBb93a944A3A6;
    address constant HOLDER = 0x1111111111111111111111111111111111111111;
    address constant CREATOR_FEES = address(0xCAFE);
    address constant SWEEPER = address(0xB0B);
    string fixture;

    function setUp() public {
        fixture = vm.readFile(vm.envString("REWARDS_FIXTURE"));
        vm.createSelectFork(
            vm.envOr("PLUGGED_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")),
            vm.envOr("REWARDS_FORK_BLOCK", uint256(102763698))
        );
        assertEq(block.chainid, 4663);
        assertEq(LAUNCHER.codehash, 0x7bea165b15ee48f58180d7865c9026cc37a0b5f7d03d8bbbc172a2bafeb5c135);
        assertEq(HOOK.codehash, 0x0624c28bbdbd8b85633cca28a56ec5befdee09780564ad8179fc1dc6ca14bb62);
        assertEq(ROUTER.codehash, 0x67867a85f9694ba856fa05c374f588fb2b293127c5576424d7e35dc09f9b3246);
    }

    function testFork_USDGCreatorSweepAndHolderWithdraw() public {
        _rewards("USDG");
    }

    function testFork_WETHCreatorSweepAndHolderWithdraw() public {
        _rewards("WETH");
    }

    function _launch(string memory symbol, bool opening)
        internal
        returns (address pair, address token, bytes32 poolId, uint256 buy, RewardsHook.Key memory key)
    {
        string memory prefix = string.concat(".", symbol);
        pair = vm.parseJsonAddress(fixture, string.concat(prefix, ".quote"));
        buy = vm.parseUint(vm.parseJsonString(fixture, string.concat(prefix, ".buy")));
        bytes memory data = vm.parseJsonBytes(fixture, string.concat(prefix, ".calldata"));
        _word(data, 7, 400); // Distinct sell fee proves both platform-share output positions.
        _word(data, 11, 5000); // creatorBps: half of the post-platform fee.
        _word(data, 16, type(uint256).max); // Disable automatic push; test explicit holder pull.
        _word(data, 19, uint160(CREATOR_FEES));
        if (opening) {
            _word(data, 21, 120);
            _word(data, 22, 800);
        }
        deal(pair, HOLDER, buy * 5);
        vm.startPrank(HOLDER);
        RewardsERC20(pair).approve(LAUNCHER, buy);
        (bool ok, bytes memory result) = LAUNCHER.call(data);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
        (token, poolId) = abi.decode(result, (address, bytes32));
        vm.stopPrank();
        assertEq(token, vm.parseJsonAddress(fixture, string.concat(prefix, ".token")));
        bool tokenFirst = token < pair;
        key = RewardsHook.Key(tokenFirst ? token : pair, tokenFirst ? pair : token, 0, 60, HOOK);
        assertEq(poolId, keccak256(abi.encode(key)));
        assertGt(RewardsERC20(token).balanceOf(HOLDER), 0);
    }

    function _rewards(string memory symbol) internal {
        (address pair, address token, bytes32 poolId, uint256 buy, RewardsHook.Key memory key) = _launch(symbol, false);
        RewardsDistributor dist = RewardsDistributor(RewardsERC20(token).distributor());
        uint256 creatorBefore = RewardsERC20(pair).balanceOf(CREATOR_FEES);
        uint256 sweeperBefore = RewardsERC20(pair).balanceOf(SWEEPER);
        assertEq(dist.payoutToken(), pair);
        assertEq(dist.shareOf(HOLDER), RewardsERC20(token).balanceOf(HOLDER));
        _checkConfig(poolId, pair, address(dist), false);
        vm.startPrank(HOLDER);
        RewardsERC20(pair).approve(ROUTER, buy);
        uint256 bought = RewardsRouter(ROUTER).swap(key, pair < token, buy, 1, HOLDER);
        assertGt(bought, 0);
        vm.stopPrank();
        uint256 pending = RewardsHook(HOOK).pendingFees(poolId);
        assertGt(pending, 0);
        assertEq(dist.withdrawableOf(HOLDER), 0);
        assertEq(RewardsERC20(pair).balanceOf(CREATOR_FEES), creatorBefore);
        uint256 holderBefore = RewardsERC20(pair).balanceOf(HOLDER);
        uint256 platformBefore = RewardsERC20(pair).balanceOf(RewardsHook(HOOK).platformRecipient());
        uint256 distBefore = RewardsERC20(pair).balanceOf(address(dist));
        vm.prank(SWEEPER);
        assertEq(RewardsHook(HOOK).sweep(key), pending);
        uint256 creatorPaid = RewardsERC20(pair).balanceOf(CREATOR_FEES) - creatorBefore;
        uint256 holderFunded = RewardsERC20(pair).balanceOf(address(dist)) - distBefore;
        uint256 platformPaid = RewardsERC20(pair).balanceOf(RewardsHook(HOOK).platformRecipient()) - platformBefore;
        uint256 bounty = RewardsERC20(pair).balanceOf(SWEEPER) - sweeperBefore;
        assertGt(creatorPaid, 0, "creator paid during sweep");
        assertGt(holderFunded, 0, "holder rewards funded during sweep");
        assertApproxEqAbs(creatorPaid, holderFunded, 1, "5000 bps splits post-platform remainder equally");
        assertEq(creatorPaid + holderFunded + platformPaid + bounty, pending, "all redeemed fees accounted");
        assertEq(RewardsHook(HOOK).pendingFees(poolId), 0);
        assertEq(RewardsHook(HOOK).pendingTokenFees(poolId), 0);
        assertEq(RewardsERC20(pair).balanceOf(HOLDER), holderBefore, "no instant holder payout");
        assertEq(dist.withdrawableOf(HOLDER), 0, "rewards stream rather than instant credit");
        assertEq(dist.STREAM_WINDOW(), 1 days);
        vm.warp(dist.streamFinish() + 1);
        uint256 claimable = dist.withdrawableOf(HOLDER);
        assertGt(claimable, 0);
        uint256 withdrawnBefore = dist.withdrawnOf(HOLDER);
        uint256 totalWithdrawnBefore = dist.totalWithdrawn();
        vm.prank(HOLDER);
        uint256 paid = dist.withdraw();
        assertEq(paid, claimable);
        assertEq(RewardsERC20(pair).balanceOf(HOLDER) - holderBefore, paid);
        assertEq(dist.withdrawnOf(HOLDER) - withdrawnBefore, paid);
        assertEq(dist.totalWithdrawn() - totalWithdrawnBefore, paid);
        assertEq(dist.withdrawableOf(HOLDER), 0);
        assertLe(paid, holderFunded);
        assertLe(holderFunded - paid, 2, "only rounding dust left");
        vm.prank(HOLDER);
        vm.expectRevert();
        dist.withdraw();
        emit log_named_string("pair", symbol);
        emit log_named_uint("pending fees", pending);
        emit log_named_uint("creator paid on sweep", creatorPaid);
        emit log_named_uint("holder distributor funded", holderFunded);
        emit log_named_uint("platform paid", platformPaid);
        emit log_named_uint("sweep bounty", bounty);
        emit log_named_uint("holder withdrawn", paid);
    }

    function testFork_PoolConfigFourteenWordOrder() public {
        (address pair, address token, bytes32 poolId,,) = _launch("USDG", true);
        _checkConfig(poolId, pair, RewardsERC20(token).distributor(), true);
    }

    function _checkConfig(bytes32 poolId, address pair, address distributor, bool opening) internal view {
        (bool ok, bytes memory raw) = HOOK.staticcall(abi.encodeWithSignature("poolConfig(bytes32)", poolId));
        assertTrue(ok);
        assertEq(raw.length, 14 * 32);
        uint256[14] memory cfg = abi.decode(raw, (uint256[14]));
        assertEq(address(uint160(cfg[0])), distributor);
        assertEq(address(uint160(cfg[1])), pair);
        assertEq(cfg[2], 200);
        assertEq(address(uint160(cfg[3])), CREATOR_FEES);
        assertEq(cfg[4], 5000);
        assertEq(cfg[5], 1);
        assertEq(cfg[6], 400);
        assertEq(cfg[7], 0);
        assertEq(cfg[8], 5000);
        assertEq(cfg[9], 2500);
        assertEq(cfg[10], opening ? block.timestamp + 120 : 0);
        assertEq(cfg[11], opening ? 120 : 0);
        assertEq(cfg[12], opening ? 800 : 0);
        assertEq(address(uint160(cfg[13])), pair);
    }

    function testFork_DeferredClaimsNotInDeployedRuntime() public {
        string[4] memory sigs = [
            "claimStuckFees(address)",
            "stuckFeesOf(address,address)",
            "stuckFees(address,address)",
            "stuckTotal(address)"
        ];
        for (uint256 i; i < sigs.length; ++i) {
            bytes memory data = i == 1 || i == 2
                ? abi.encodeWithSignature(sigs[i], LAUNCHER, HOLDER)
                : abi.encodeWithSignature(sigs[i], LAUNCHER);
            (bool ok, bytes memory result) = HOOK.call(data);
            assertFalse(ok, sigs[i]);
            assertEq(result.length, 0, "unknown selector has empty revert data");
        }
    }

    function _word(bytes memory data, uint256 tupleIndex, uint256 value) internal pure {
        // selector (4), dynamic tuple pointer (32), then tuple head words.
        uint256 offset = 36 + tupleIndex * 32;
        require(offset + 32 <= data.length, "fixture tuple out of bounds");
        assembly { mstore(add(add(data, 32), offset), value) }
    }
}
