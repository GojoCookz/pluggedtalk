// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BasketLedger} from "carbon/src/multi/BasketLedger.sol";
import {PluggedAdvancedLedger} from "./PluggedAdvancedLedger.sol";
import {LaunchMetadata} from "carbon/src/types/LaunchMetadata.sol";

/// @notice Carbon MultiLaunchToken adaptation with an unconditional 3% per-address holding cap.
/// @dev Separate clone target: Carbon's non-virtual initializer and update cannot be safely overridden.
///      The Carbon-compatible ledger fixes magnified stream dust (see PluggedAdvancedLedger). No transfer tax,
///      mint authority, owner, exemption setter, or launcher-origin delivery bypass exists.
contract PluggedAdvancedToken is ERC20 {
    uint16 public constant MAX_WALLET_BPS = 300;
    BasketLedger public ledger;
    address public poolManager;
    address public launchConduit;
    uint256 public maxWallet;
    LaunchMetadata public metadata;
    mapping(address => bool) public exemptFromMaxWallet;
    string private _tokenName;
    string private _tokenSymbol;
    bool private _initialized;
    bool private _feedsWired;

    struct InitParams {
        string name_;
        string symbol_;
        uint256 supply;
        address recipient;
        address[] currencies;
        uint256[] minPushPayout;
        address controller;
        address poolManager_;
        uint256 minShareForQueue;
        LaunchMetadata metadata;
    }

    error AlreadyInitialized();
    error InvalidInitialization();
    error OnlyConduit();
    error FeedsAlreadyWired();
    error InvalidFeeds();
    error MaxWalletExceeded(address to, uint256 attempted, uint256 cap);
    event ProtocolExemption(address indexed account);

    constructor() ERC20("", "") {
        _initialized = true;
    }

    function initialize(InitParams calldata p) external {
        if (_initialized) revert AlreadyInitialized();
        if (
            p.supply < 1e18 || p.recipient != msg.sender || p.recipient.code.length == 0
                || p.controller.code.length == 0 || p.poolManager_.code.length == 0
                || p.currencies.length == 0 || p.currencies.length > 4
                || p.currencies.length != p.minPushPayout.length
        ) revert InvalidInitialization();
        _initialized = true;
        _tokenName = p.name_;
        _tokenSymbol = p.symbol_;
        poolManager = p.poolManager_;
        launchConduit = p.recipient;
        maxWallet = Math.mulDiv(p.supply, MAX_WALLET_BPS, 10_000);
        metadata = p.metadata;
        ledger = BasketLedger(
            address(
                new PluggedAdvancedLedger(
                    address(this),
                    p.controller,
                    p.poolManager_,
                    p.recipient,
                    p.currencies,
                    p.minPushPayout,
                    p.minShareForQueue,
                    p.supply / 1e6
                )
            )
        );
        _exempt(p.poolManager_);
        _exempt(p.recipient);
        _exempt(p.controller);
        _exempt(address(this));
        _exempt(address(ledger));
        _exempt(address(0xdEaD));
        _mint(p.recipient, p.supply);
    }

    function _exempt(address account) private {
        exemptFromMaxWallet[account] = true;
        emit ProtocolExemption(account);
    }

    /// @notice Atomic factory wiring; each currency must match the ledger's immutable order.
    function wireFeeds(address[] calldata currencies, address[] calldata feeds) external {
        if (msg.sender != launchConduit) revert OnlyConduit();
        if (_feedsWired) revert FeedsAlreadyWired();
        if (currencies.length != ledger.marketCount() || currencies.length != feeds.length) {
            revert InvalidFeeds();
        }
        _feedsWired = true;
        for (uint256 i; i < currencies.length; ++i) {
            if (currencies[i] != ledger.marketAt(i) || feeds[i].code.length == 0) revert InvalidFeeds();
            ledger.initFeed(currencies[i], feeds[i]);
        }
    }

    function name() public view override returns (string memory) {
        return _tokenName;
    }

    function symbol() public view override returns (string memory) {
        return _tokenSymbol;
    }

    function _update(address from, address to, uint256 value) internal override {
        // Self-transfers do not increase holdings. Every other inbound path, including creator
        // delivery and vest release, is capped. PoolManager is exempt so selling stays possible.
        if (!exemptFromMaxWallet[to] && to != address(0) && from != to) {
            uint256 resulting = balanceOf(to) + value;
            if (resulting > maxWallet) revert MaxWalletExceeded(to, resulting, maxWallet);
        }
        super._update(from, to, value);
        if (from != address(0)) ledger.setBalance(from, balanceOf(from));
        if (to != address(0)) ledger.setBalance(to, balanceOf(to));
    }
}
