// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {Test} from "forge-std/Test.sol";
import {PluggedLaunchRegistry} from "../src/PluggedLaunchRegistry.sol";
import {QuoteToken} from "./PluggedFeeSplitter.t.sol";

contract LaunchRegistryTest is Test {
    PluggedLaunchRegistry registry;
    QuoteToken token;
    bytes32 settings = keccak256("economic-settings");

    function setUp() public {
        registry = new PluggedLaunchRegistry(address(this));
        token = new QuoteToken();
    }

    function test_CaseVariantsCannotVampSameEconomics() public {
        registry.register("pLuG", " My\tCoin ", settings, address(token));
        bytes32 key = keccak256(abi.encode("PLUG", "MY COIN", settings));
        assertEq(registry.tokenFor(key), address(token));
        vm.expectRevert(
            abi.encodeWithSelector(PluggedLaunchRegistry.DuplicateLaunch.selector, key, address(token))
        );
        registry.register("PLUG", "my coin", settings, address(token));
    }

    function test_OnlyFactoryCanRegisterNoPublicSquatting() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(PluggedLaunchRegistry.Unauthorized.selector);
        registry.register("PLUG", "My Coin", settings, address(token));
        assertEq(registry.tokenFor(registry.fingerprint("PLUG", "My Coin", settings)), address(0));
    }

    function test_RejectsUnicodeWhitespaceAndMissingCode() public {
        vm.expectRevert(PluggedLaunchRegistry.InvalidTicker.selector);
        registry.register("PL UG", "My Coin", settings, address(token));
        vm.expectRevert(PluggedLaunchRegistry.InvalidTicker.selector);
        registry.register(unicode"ＰＬＵＧ", "My Coin", settings, address(token));
        vm.expectRevert(PluggedLaunchRegistry.InvalidLaunch.selector);
        registry.register("PLUG", "My Coin", settings, address(0x123));
        vm.expectRevert(PluggedLaunchRegistry.InvalidName.selector);
        registry.register("PLUG", " \t\r\n", settings, address(token));
    }

    function test_DifferentSettingsAreDistinctAsRequested() public {
        registry.register("PLUG", "My Coin", settings, address(token));
        bytes32 other = keccak256("different-economics");
        registry.register("plug", "My Coin", other, address(token));
        assertEq(registry.tokenFor(registry.fingerprint("PLUG", "My Coin", other)), address(token));
    }

    function test_DifferentNameIsDistinctAsClarified() public {
        registry.register("PLUG", "My Coin", settings, address(token));
        registry.register("PLUG", "Other Coin", settings, address(token));
        assertTrue(
            registry.fingerprint("PLUG", "My Coin", settings)
                != registry.fingerprint("PLUG", "Other Coin", settings)
        );
        assertEq(registry.canonicalName(unicode" Café Coin "), unicode"CAFé COIN");
    }
}
