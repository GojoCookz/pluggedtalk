// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title PluggedFeeVaultInbox
/// @notice Per-container receiving address. Usable as a fixed PluggedFeeSplitter / advanced-feed
///         recipient slot, because those contracts push funds without a deposit callback.
/// @dev Holds funds only until anyone calls PluggedFeeVault.sweepInbox(id). Only the vault can move them,
///      and only to itself.
contract PluggedFeeVaultInbox {
    using SafeERC20 for IERC20;

    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable vault;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable currency;

    error OnlyVault();
    error WrongCurrency();
    error NativeForwardFailed();

    constructor(address currency_) {
        vault = msg.sender;
        currency = currency_;
    }

    receive() external payable {
        if (currency != address(0)) revert WrongCurrency();
    }

    function forward() external returns (uint256 amount) {
        if (msg.sender != vault) revert OnlyVault();
        if (currency == address(0)) {
            amount = address(this).balance;
            if (amount != 0) {
                (bool ok,) = payable(vault).call{value: amount}("");
                if (!ok) revert NativeForwardFailed();
            }
        } else {
            amount = IERC20(currency).balanceOf(address(this));
            if (amount != 0) IERC20(currency).safeTransfer(vault, amount);
        }
    }
}

/// @title PluggedFeeVault
/// @notice Reclaimable per-recipient fee containers. Fees for an invited recipient (for example a
///         social/GitHub-resolved wallet) accrue in a PENDING container. The recipient accepts by
///         sending a transaction from the exact payout wallet; accepted balances can never be
///         reclaimed by anyone. A declined or expired container returns funds to its fixed allocator.
/// @dev No owner, no upgrade, no rescue, no redirect. Allocator, recipient, currency and optional operator
///      are fixed at creation. Fee-on-transfer, rebasing and sender-surcharge tokens are rejected by
///      exact balance-delta checks; use vetted plain ERC-20s or address(0) for native ETH.
///      Conservation: for every currency, totalHeld == sum(container.balance) <= vault balance, and
///      totalCredited == totalHeld + totalPaid.
contract PluggedFeeVault is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    enum State {
        NONE,
        PENDING,
        ACCEPTED,
        DECLINED,
        RECLAIMED,
        EXPIRED // derived only: stored PENDING with block.timestamp >= deadline
    }

    struct Container {
        address allocator;
        uint40 createdAt;
        uint40 deadline;
        State state;
        address recipient;
        address currency;
        address operator;
        address inbox;
        bytes32 inviteRef;
        uint256 balance;
        uint256 credited;
        uint256 paid;
    }

    uint256 public constant MIN_WINDOW = 7 days;
    uint256 public constant DEFAULT_WINDOW = 30 days;
    uint256 public constant MAX_WINDOW = 365 days;

    uint256 public containerCount;
    mapping(uint256 => Container) private _containers;
    mapping(address => uint256[]) private _byRecipient;
    mapping(address => uint256[]) private _byAllocator;
    mapping(address => bool) public isInbox;
    mapping(address => uint256) public totalHeld;
    mapping(address => uint256) public totalCredited;
    mapping(address => uint256) public totalPaid;

    error UnknownContainer();
    error InvalidRecipient();
    error InvalidCurrency();
    error InvalidWindow();
    error InvalidDeadline();
    error InvalidState(State state);
    error Unauthorized();
    error ZeroAmount();
    error NothingToPay();
    error NativePaymentFailed();
    error UnsupportedTokenBehavior();
    error UnexpectedNative();

    event ContainerCreated(
        uint256 indexed id,
        address indexed allocator,
        address indexed recipient,
        address currency,
        address inbox,
        address operator,
        uint40 deadline,
        bytes32 inviteRef
    );
    event Deposited(uint256 indexed id, address indexed from, uint256 amount);
    event InboxSwept(uint256 indexed id, address indexed caller, uint256 amount);
    event Accepted(uint256 indexed id, address indexed recipient, uint256 balance);
    event Declined(uint256 indexed id, address indexed recipient, uint256 balance);
    event Claimed(uint256 indexed id, address indexed recipient, address currency, uint256 amount);
    event Reclaimed(uint256 indexed id, address indexed allocator, address indexed caller, address currency, uint256 amount);
    event DeadlineExtended(uint256 indexed id, address indexed caller, uint40 previousDeadline, uint40 newDeadline);

    receive() external payable {
        // Only inbox forwarding may send bare ETH. Deposits use depositNative(id) to be attributed.
        if (!isInbox[msg.sender]) revert UnexpectedNative();
    }

    // ---------------------------------------------------------------- creation

    /// @param window Seconds until expiry; 0 selects DEFAULT_WINDOW. Bounded [MIN_WINDOW, MAX_WINDOW].
    /// @param operator Optional (address(0) = none). May only extend the deadline or return an
    ///        unaccepted container to the allocator. Never touches accepted balances.
    /// @param salt Caller-chosen. The inbox address depends only on (caller, recipient, currency, salt),
    ///        never on the global id, so a precomputed inbox cannot be captured by another creator.
    function createContainer(
        address recipient,
        address currency,
        uint256 window,
        address operator,
        bytes32 inviteRef,
        bytes32 salt
    )
        external
        nonReentrant
        returns (uint256 id, address inbox)
    {
        if (recipient == address(0) || recipient == address(this) || recipient == msg.sender || isInbox[recipient]) {
            revert InvalidRecipient();
        }
        if (currency != address(0) && currency.code.length == 0) revert InvalidCurrency();
        if (window == 0) window = DEFAULT_WINDOW;
        if (window < MIN_WINDOW || window > MAX_WINDOW) revert InvalidWindow();
        id = ++containerCount;
        inbox = address(new PluggedFeeVaultInbox{salt: _inboxSalt(msg.sender, recipient, currency, salt)}(currency));
        isInbox[inbox] = true;
        uint40 deadline = uint40(block.timestamp + window);
        Container storage c = _containers[id];
        c.allocator = msg.sender;
        c.createdAt = uint40(block.timestamp);
        c.deadline = deadline;
        c.state = State.PENDING;
        c.recipient = recipient;
        c.currency = currency;
        c.operator = operator;
        c.inbox = inbox;
        c.inviteRef = inviteRef;
        _byRecipient[recipient].push(id);
        _byAllocator[msg.sender].push(id);
        emit ContainerCreated(id, msg.sender, recipient, currency, inbox, operator, deadline, inviteRef);
    }

    // ---------------------------------------------------------------- funding

    function deposit(uint256 id, uint256 amount) external nonReentrant {
        Container storage c = _existing(id);
        if (c.currency == address(0)) revert InvalidCurrency();
        if (amount == 0) revert ZeroAmount();
        IERC20 token = IERC20(c.currency);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) != before + amount) revert UnsupportedTokenBehavior();
        _credit(c, amount);
        emit Deposited(id, msg.sender, amount);
    }

    function depositNative(uint256 id) external payable nonReentrant {
        Container storage c = _existing(id);
        if (c.currency != address(0)) revert InvalidCurrency();
        if (msg.value == 0) revert ZeroAmount();
        _credit(c, msg.value);
        emit Deposited(id, msg.sender, msg.value);
    }

    /// @notice Permissionless. Moves funds pushed to the container inbox (e.g. by a splitter) into the
    ///         container balance. Credits follow the container's current state rules.
    function sweepInbox(uint256 id) public nonReentrant returns (uint256 amount) {
        amount = _sweep(id);
    }

    // ---------------------------------------------------------------- recipient

    /// @notice The transaction signer IS the proof of control of the exact payout wallet.
    function accept(uint256 id) external nonReentrant {
        Container storage c = _existing(id);
        if (msg.sender != c.recipient) revert Unauthorized();
        State s = _status(c);
        if (s != State.PENDING) revert InvalidState(s);
        c.state = State.ACCEPTED;
        emit Accepted(id, msg.sender, c.balance);
    }

    function decline(uint256 id) external nonReentrant {
        Container storage c = _existing(id);
        if (msg.sender != c.recipient) revert Unauthorized();
        State s = _status(c);
        if (s != State.PENDING) revert InvalidState(s);
        c.state = State.DECLINED;
        emit Declined(id, msg.sender, c.balance);
    }

    /// @notice Pays the full accepted balance (after sweeping the inbox) to the fixed recipient.
    function claim(uint256 id) external nonReentrant returns (uint256 amount) {
        Container storage c = _existing(id);
        if (msg.sender != c.recipient) revert Unauthorized();
        if (c.state != State.ACCEPTED) revert InvalidState(_status(c));
        _sweep(id);
        amount = c.balance;
        if (amount == 0) revert NothingToPay();
        _debit(c, amount);
        _pay(c.currency, c.recipient, amount);
        emit Claimed(id, c.recipient, c.currency, amount);
    }

    // ---------------------------------------------------------------- allocator / operator

    /// @notice Allocator pulls an unaccepted container's balance back after decline or expiry.
    ///         Repeatable: later inbox inflows to a declined/reclaimed container also return here.
    function reclaim(uint256 id) external nonReentrant returns (uint256 amount) {
        Container storage c = _existing(id);
        if (msg.sender != c.allocator) revert Unauthorized();
        State s = _status(c);
        if (s != State.DECLINED && s != State.EXPIRED && s != State.RECLAIMED) revert InvalidState(s);
        amount = _returnToAllocator(id, c);
    }

    /// @notice Operator only. Returns a still-PENDING (or expired) container to its fixed allocator.
    function operatorReturn(uint256 id) external nonReentrant returns (uint256 amount) {
        Container storage c = _existing(id);
        if (c.operator == address(0) || msg.sender != c.operator) revert Unauthorized();
        State s = _status(c);
        if (s != State.PENDING && s != State.EXPIRED && s != State.DECLINED && s != State.RECLAIMED) {
            revert InvalidState(s);
        }
        amount = _returnToAllocator(id, c);
    }

    /// @notice Allocator or operator may give the recipient more time while unaccepted and not yet reclaimed.
    function extendDeadline(uint256 id, uint40 newDeadline) external nonReentrant {
        Container storage c = _existing(id);
        if (msg.sender != c.allocator && (c.operator == address(0) || msg.sender != c.operator)) revert Unauthorized();
        if (c.state != State.PENDING) revert InvalidState(_status(c));
        if (newDeadline <= c.deadline || newDeadline <= block.timestamp || newDeadline > block.timestamp + MAX_WINDOW) {
            revert InvalidDeadline();
        }
        uint40 previous = c.deadline;
        c.deadline = newDeadline;
        emit DeadlineExtended(id, msg.sender, previous, newDeadline);
    }

    // ---------------------------------------------------------------- views

    function getContainer(uint256 id) external view returns (Container memory c) {
        c = _containers[id];
        if (c.state == State.NONE) revert UnknownContainer();
        c.state = _status(_containers[id]);
    }

    function status(uint256 id) external view returns (State) {
        return _status(_existing(id));
    }

    /// @notice Balance a recipient could claim now (accepted only), including unswept inbox funds.
    function claimable(uint256 id) external view returns (uint256) {
        Container storage c = _existing(id);
        return c.state == State.ACCEPTED ? c.balance + _inboxBalance(c) : 0;
    }

    /// @notice Balance the allocator could reclaim now, including unswept inbox funds.
    function reclaimable(uint256 id) external view returns (uint256) {
        Container storage c = _existing(id);
        State s = _status(c);
        return (s == State.DECLINED || s == State.EXPIRED || s == State.RECLAIMED) ? c.balance + _inboxBalance(c) : 0;
    }

    function inboxBalance(uint256 id) external view returns (uint256) {
        return _inboxBalance(_existing(id));
    }

    function recipientContainerCount(address recipient) external view returns (uint256) {
        return _byRecipient[recipient].length;
    }

    function allocatorContainerCount(address allocator) external view returns (uint256) {
        return _byAllocator[allocator].length;
    }

    function recipientContainers(address recipient, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_byRecipient[recipient], offset, limit);
    }

    function allocatorContainers(address allocator, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_byAllocator[allocator], offset, limit);
    }

    // ---------------------------------------------------------------- internals

    /// @notice Inbox address createContainer will deploy for this allocator and parameters.
    function predictInbox(address allocator, address recipient, address currency, bytes32 salt)
        external
        view
        returns (address)
    {
        bytes32 initCode = keccak256(abi.encodePacked(type(PluggedFeeVaultInbox).creationCode, abi.encode(currency)));
        bytes32 digest = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), _inboxSalt(allocator, recipient, currency, salt), initCode)
        );
        return address(uint160(uint256(digest)));
    }

    function _inboxSalt(address allocator, address recipient, address currency, bytes32 salt)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(allocator, recipient, currency, salt));
    }

    function _existing(uint256 id) private view returns (Container storage c) {
        c = _containers[id];
        if (c.state == State.NONE) revert UnknownContainer();
    }

    function _status(Container storage c) private view returns (State) {
        if (c.state == State.PENDING && block.timestamp >= c.deadline) return State.EXPIRED;
        return c.state;
    }

    function _inboxBalance(Container storage c) private view returns (uint256) {
        return c.currency == address(0) ? c.inbox.balance : IERC20(c.currency).balanceOf(c.inbox);
    }

    function _sweep(uint256 id) private returns (uint256 amount) {
        Container storage c = _existing(id);
        uint256 before = _balance(c.currency);
        amount = PluggedFeeVaultInbox(payable(c.inbox)).forward();
        if (_balance(c.currency) != before + amount) revert UnsupportedTokenBehavior();
        if (amount != 0) {
            _credit(c, amount);
            emit InboxSwept(id, msg.sender, amount);
        }
    }

    function _returnToAllocator(uint256 id, Container storage c) private returns (uint256 amount) {
        _sweep(id);
        c.state = State.RECLAIMED;
        amount = c.balance;
        if (amount == 0) revert NothingToPay();
        _debit(c, amount);
        _pay(c.currency, c.allocator, amount);
        emit Reclaimed(id, c.allocator, msg.sender, c.currency, amount);
    }

    function _credit(Container storage c, uint256 amount) private {
        c.balance += amount;
        c.credited += amount;
        totalHeld[c.currency] += amount;
        totalCredited[c.currency] += amount;
    }

    function _debit(Container storage c, uint256 amount) private {
        c.balance -= amount;
        c.paid += amount;
        totalHeld[c.currency] -= amount;
        totalPaid[c.currency] += amount;
    }

    function _pay(address currency, address to, uint256 amount) private {
        if (currency == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert NativePaymentFailed();
        } else {
            IERC20 token = IERC20(currency);
            uint256 beforeSelf = token.balanceOf(address(this));
            uint256 beforeTo = token.balanceOf(to);
            token.safeTransfer(to, amount);
            if (token.balanceOf(address(this)) != beforeSelf - amount || token.balanceOf(to) != beforeTo + amount) {
                revert UnsupportedTokenBehavior();
            }
        }
    }

    function _balance(address currency) private view returns (uint256) {
        return currency == address(0) ? address(this).balance : IERC20(currency).balanceOf(address(this));
    }

    function _page(uint256[] storage ids, uint256 offset, uint256 limit) private view returns (uint256[] memory out) {
        uint256 n = ids.length;
        if (offset >= n) return new uint256[](0);
        uint256 end = offset + limit > n ? n : offset + limit;
        out = new uint256[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            out[i - offset] = ids[i];
        }
    }
}
