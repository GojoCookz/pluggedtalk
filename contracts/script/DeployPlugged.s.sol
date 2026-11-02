// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {PairRegistry} from "carbon/src/PairRegistry.sol";
import {LaunchToken} from "carbon/src/LaunchToken.sol";
import {FeeHook} from "carbon/src/FeeHook.sol";
import {Launcher} from "carbon/src/Launcher.sol";
import {TradeRouter} from "carbon/src/TradeRouter.sol";

/// @notice Independent Carbon baseline. Simulate without --broadcast; no private-key input.
/// @dev Registry owner is constructor-set. No ownership transfer, referrals, pair approvals or zap.
contract DeployPlugged is Script {
    address public constant MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address public constant CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant COMPROMISED = 0xc286b1956c7691d678520e370727D8aB57328556;
    bytes32 internal constant MANAGER_HASH =
        0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626;
    bytes internal constant CREATE2_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    struct Deployment {
        PairRegistry registry;
        LaunchToken implementation;
        FeeHook hook;
        Launcher launcher;
        TradeRouter router;
    }

    error InvalidAddress();
    error WrongChain();
    error InfrastructureMismatch();
    error AddressReservationFailed();
    error ManifestExists();

    function run(address owner, address platform, address deployer) external returns (Deployment memory d) {
        if (block.chainid != 4663) revert WrongChain();
        _validate(owner);
        _validate(platform);
        _validate(deployer);
        if (MANAGER.codehash != MANAGER_HASH || CREATE2.codehash != keccak256(CREATE2_CODE)) {
            revert InfrastructureMismatch();
        }
        string memory output = vm.envOr("PLUGGED_MANIFEST_OUT", string(""));
        if (bytes(output).length != 0 && vm.exists(output)) revert ManifestExists();
        uint64 nonce = vm.getNonce(deployer);
        // No referral vault: registry n, token n+1, CREATE2 transaction n+2, launcher n+3, router n+4.
        address reserved = vm.computeCreateAddress(deployer, nonce + 3);
        (address hookAddress, bytes32 salt) = HookMiner.find(
            CREATE2, 0x20cc, type(FeeHook).creationCode, abi.encode(IPoolManager(MANAGER), reserved, platform)
        );
        vm.startBroadcast(deployer);
        d.registry = new PairRegistry(owner);
        d.implementation = new LaunchToken();
        d.hook = new FeeHook{salt: salt}(IPoolManager(MANAGER), reserved, platform);
        d.launcher = new Launcher(IPoolManager(MANAGER), d.hook, d.registry, address(d.implementation));
        d.router = new TradeRouter(IPoolManager(MANAGER));
        vm.stopBroadcast();
        if (
            address(d.registry) != vm.computeCreateAddress(deployer, nonce)
                || address(d.implementation) != vm.computeCreateAddress(deployer, nonce + 1)
                || address(d.hook) != hookAddress || address(d.launcher) != reserved
                || address(d.router) != vm.computeCreateAddress(deployer, nonce + 4)
        ) revert AddressReservationFailed();
        string memory manifest = _manifest(d, owner, platform, deployer, nonce, salt);
        if (bytes(output).length != 0) vm.writeJson(manifest, output);
        console.log(manifest);
    }

    function _validate(address value) internal pure {
        if (value == address(0) || value == COMPROMISED) revert InvalidAddress();
    }

    function _record(string memory role, address target) internal returns (string memory) {
        vm.serializeAddress("deployment", role, target);
        vm.serializeAddress(role, "address", target);
        vm.serializeBytes32(role, "codeHash", target.codehash);
        string memory entry = vm.serializeUint(role, "codeBytes", target.code.length);
        return vm.serializeString("hashes", role, entry);
    }

    function _manifest(
        Deployment memory d,
        address owner,
        address platform,
        address deployer,
        uint64 nonce,
        bytes32 salt
    ) internal returns (string memory) {
        _record("launcher", address(d.launcher));
        _record("pairRegistry", address(d.registry));
        _record("feeHook", address(d.hook));
        _record("tradeRouter", address(d.router));
        _record("tokenImplementation", address(d.implementation));
        string memory hashes = _record("poolManager", MANAGER);
        vm.serializeUint("profile", "schemaVersion", 1);
        vm.serializeUint("profile", "chainId", block.chainid);
        vm.serializeString("profile", "engine", "carbon-baseline-v1");
        // Always simulated: promotion requires the CLI's explicit live code/link verification.
        vm.serializeString("profile", "status", "simulated");
        vm.serializeBool("profile", "independent", true);
        vm.serializeAddress("profile", "ownerAddress", owner);
        vm.serializeAddress("profile", "platformRecipientAddress", platform);
        vm.serializeAddress("profile", "deployerAddress", deployer);
        vm.serializeUint("profile", "startingNonce", nonce);
        vm.serializeBytes32("profile", "hookSalt", salt);
        vm.serializeBytes32(
            "profile",
            "hookInitCodeHash",
            keccak256(
                abi.encodePacked(
                    type(FeeHook).creationCode,
                    abi.encode(IPoolManager(MANAGER), address(d.launcher), platform)
                )
            )
        );
        vm.serializeUint("profile", "blockNumber", block.number);
        vm.serializeUint("profile", "platformVolumeBps", 100);
        vm.serializeUint("profile", "maxFeeBps", 1000);
        vm.serializeString("profile", "deployment", vm.serializeUint("deployment", "chainId", block.chainid));
        return vm.serializeString("profile", "hashes", hashes);
    }
}
