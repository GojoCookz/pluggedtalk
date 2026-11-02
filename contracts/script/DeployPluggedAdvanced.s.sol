// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {PairRegistry} from "carbon/src/PairRegistry.sol";
import {FeeHook} from "carbon/src/FeeHook.sol";
import {TradeRouter} from "carbon/src/TradeRouter.sol";
import {MultiDeployer} from "carbon/src/multi/MultiDeployer.sol";
import {PluggedAdvancedFactory} from "../src/PluggedAdvancedFactory.sol";
import {PluggedAdvancedToken} from "../src/PluggedAdvancedToken.sol";

/// @notice Separate advanced deployment, never an upgrade to an existing Carbon engine.
contract DeployPluggedAdvanced is Script {
    address public constant MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address public constant CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant COMPROMISED = 0xc286b1956c7691d678520e370727D8aB57328556;
    bytes32 internal constant MANAGER_HASH =
        0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626;
    bytes internal constant CREATE2_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    struct Deployment {
        PairRegistry pairs;
        PluggedAdvancedToken implementation;
        MultiDeployer satellites;
        FeeHook hook;
        PluggedAdvancedFactory factory;
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
        // pairs n, token n+1, satellites n+2, CREATE2 transaction n+3, factory n+4, router n+5.
        address reserved = vm.computeCreateAddress(deployer, nonce + 4);
        (address hookAddress, bytes32 salt) = HookMiner.find(
            CREATE2, 0x20cc, type(FeeHook).creationCode, abi.encode(IPoolManager(MANAGER), reserved, platform)
        );
        vm.startBroadcast(deployer);
        d.pairs = new PairRegistry(owner);
        d.implementation = new PluggedAdvancedToken();
        d.satellites = new MultiDeployer();
        d.hook = new FeeHook{salt: salt}(IPoolManager(MANAGER), reserved, platform);
        d.factory = new PluggedAdvancedFactory(
            IPoolManager(MANAGER), d.hook, d.pairs, address(d.implementation), d.satellites
        );
        d.router = new TradeRouter(IPoolManager(MANAGER));
        vm.stopBroadcast();
        if (
            address(d.pairs) != vm.computeCreateAddress(deployer, nonce)
                || address(d.implementation) != vm.computeCreateAddress(deployer, nonce + 1)
                || address(d.satellites) != vm.computeCreateAddress(deployer, nonce + 2)
                || address(d.hook) != hookAddress || address(d.factory) != reserved
                || address(d.router) != vm.computeCreateAddress(deployer, nonce + 5)
                || d.factory.registry().FACTORY() != reserved
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
        return vm.serializeString("hashes", role, vm.serializeUint(role, "codeBytes", target.code.length));
    }

    function _manifest(
        Deployment memory d,
        address owner,
        address platform,
        address deployer,
        uint64 nonce,
        bytes32 salt
    ) internal returns (string memory) {
        _record("launcher", address(d.factory));
        _record("factory", address(d.factory));
        _record("launchRegistry", address(d.factory.registry()));
        _record("satellites", address(d.satellites));
        _record("pairRegistry", address(d.pairs));
        _record("feeHook", address(d.hook));
        _record("tradeRouter", address(d.router));
        _record("tokenImplementation", address(d.implementation));
        string memory hashes = _record("poolManager", MANAGER);
        vm.serializeUint("profile", "schemaVersion", 1);
        vm.serializeUint("profile", "chainId", block.chainid);
        vm.serializeString("profile", "engine", "plugged-advanced-v1");
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
                    abi.encode(IPoolManager(MANAGER), address(d.factory), platform)
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
