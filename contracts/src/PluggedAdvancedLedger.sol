// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @notice Plugged-local adaptation of Carbon BasketLedger. ABI, accounting, exclusions, feed
///         authority, payout queue and 24-hour streaming match Carbon. The only accounting change
///         is _arm: conserve magnified stream dust rather than booking rounded dust twice.
/// @dev Carbon's _arm and entry points are non-virtual, so inheritance cannot repair this path.
///      Original source: contracts/src/multi/BasketLedger.sol (MIT). No Carbon source was edited.
contract PluggedAdvancedLedger is ReentrancyGuardTransient {
    uint256 internal constant MAGNITUDE = 2 ** 128;
    uint256 public constant MAX_MARKETS = 4;
    uint64 public constant STREAM_WINDOW = 24 hours;
    address public immutable shareToken;
    address public immutable controller;
    uint256 public immutable minShareForQueue;
    uint256 public immutable minSharesForDistribution;
    mapping(address => uint256) public minPushPayout;

    struct Bucket {
        uint256 magnifiedPerShare;
        uint256 streamRate;
        uint256 remainderMag;
        uint256 pending;
        uint256 totalDistributed;
        uint256 totalWithdrawn;
        uint64 streamFinish;
        uint64 lastCheckpoint;
    }
    address[] internal _currencies;
    mapping(address => Bucket) internal _bucket;
    mapping(address => bool) public isMarketCurrency;
    mapping(address => address) public feedOf;
    mapping(address => mapping(address => int256)) internal _corrections;
    mapping(address => mapping(address => uint256)) internal _withdrawn;
    mapping(address => uint256) public shareOf;
    uint256 public totalShares;
    mapping(address => bool) public excluded;
    address[] internal _queue;
    mapping(address => uint256) internal _queueIndexPlusOne;
    uint256 public cursor;

    event PayoutsAdded(address indexed currency, uint256 amount, uint256 newMagnifiedPerShare);
    event PayoutSent(address indexed account, address indexed currency, uint256 amount);
    event PayoutSendFailed(address indexed account, address indexed currency, uint256 amount);
    event ExcludedSet(address indexed account, bool isExcluded);
    error OnlyShareToken();
    error OnlyController();
    error OnlyFeed();
    error NothingToWithdraw();
    error ZeroAddress();
    error AlreadyExcluded();
    error NoMarkets();
    error TooManyMarkets(uint256 given);
    error DuplicateMarket(address currency);
    error NotAMarket(address currency);
    error LengthMismatch();
    error FeedAlreadySet(address currency);

    modifier onlyShareToken() {
        if (msg.sender != shareToken) revert OnlyShareToken();
        _;
    }

    constructor(
        address shareToken_,
        address controller_,
        address poolManager_,
        address launcher_,
        address[] memory currencies_,
        uint256[] memory minPushPayout_,
        uint256 minShareForQueue_,
        uint256 minSharesForDistribution_
    ) {
        if (shareToken_ == address(0) || controller_ == address(0)) {
            revert ZeroAddress();
        }
        if (currencies_.length != minPushPayout_.length) revert LengthMismatch();
        if (currencies_.length == 0) revert NoMarkets();
        if (currencies_.length > MAX_MARKETS) revert TooManyMarkets(currencies_.length);
        shareToken = shareToken_;
        controller = controller_;
        minShareForQueue = minShareForQueue_;
        minSharesForDistribution = minSharesForDistribution_;
        for (uint256 i; i < currencies_.length; ++i) {
            address c = currencies_[i];
            if (c == address(0)) revert ZeroAddress();
            if (isMarketCurrency[c]) revert DuplicateMarket(c);
            isMarketCurrency[c] = true;
            _currencies.push(c);
            minPushPayout[c] = minPushPayout_[i];
        }
        excluded[address(0)] = true;
        excluded[address(0xdEaD)] = true;
        excluded[address(this)] = true;
        if (poolManager_ != address(0)) excluded[poolManager_] = true;
        if (launcher_ != address(0)) excluded[launcher_] = true;
    }

    function initFeed(address currency, address feed) external {
        if (msg.sender != shareToken) revert OnlyShareToken();
        if (!isMarketCurrency[currency]) revert NotAMarket(currency);
        if (feedOf[currency] != address(0)) revert FeedAlreadySet(currency);
        if (feed == address(0)) revert ZeroAddress();
        feedOf[currency] = feed;
    }

    function marketCount() external view returns (uint256) {
        return _currencies.length;
    }

    function marketAt(uint256 i) external view returns (address) {
        return _currencies[i];
    }

    function currencies() external view returns (address[] memory) {
        return _currencies;
    }

    function bucketOf(address currency) external view returns (Bucket memory) {
        return _bucket[currency];
    }

    function totalDistributedOf(address currency) external view returns (uint256) {
        return _bucket[currency].totalDistributed;
    }

    function totalWithdrawnOf(address currency) external view returns (uint256) {
        return _bucket[currency].totalWithdrawn;
    }

    function withdrawnOf(address account, address currency) external view returns (uint256) {
        return _withdrawn[currency][account];
    }

    function queueLength() external view returns (uint256) {
        return _queue.length;
    }

    function queueAt(uint256 i) external view returns (address) {
        return _queue[i];
    }

    function withdrawableOf(address account, address currency) public view returns (uint256) {
        uint256 acc = _accumulativeOf(account, currency);
        uint256 w = _withdrawn[currency][account];
        return acc > w ? acc - w : 0;
    }

    function withdrawableBasket(address account)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        uint256 n = _currencies.length;
        tokens = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            address c = _currencies[i];
            tokens[i] = c;
            amounts[i] = withdrawableOf(account, c);
        }
    }

    function _accumulativeOf(address account, address currency) internal view returns (uint256) {
        int256 acc = int256(_perShareNow(currency) * shareOf[account]) + _corrections[currency][account];
        if (acc <= 0) return 0;
        return uint256(acc) / MAGNITUDE;
    }

    function _checkpoint(address currency) internal {
        Bucket storage b = _bucket[currency];
        uint64 finish = b.streamFinish;
        uint64 upTo = uint64(block.timestamp) < finish ? uint64(block.timestamp) : finish;
        uint64 from = b.lastCheckpoint;
        if (upTo <= from) return;
        uint256 grossMag = uint256(upTo - from) * b.streamRate + b.remainderMag;
        uint256 vested = grossMag / MAGNITUDE;
        b.lastCheckpoint = upTo;
        b.remainderMag = grossMag % MAGNITUDE;
        if (vested == 0) return;
        uint256 shares = totalShares;
        if (shares == 0 || shares < minSharesForDistribution) {
            b.pending += vested;
            return;
        }
        b.magnifiedPerShare += (vested * MAGNITUDE) / shares;
        b.totalDistributed += vested;
    }

    function _checkpointAll() internal {
        for (uint256 i; i < _currencies.length; ++i) {
            _checkpoint(_currencies[i]);
        }
    }

    function _perShareNow(address currency) internal view returns (uint256) {
        Bucket storage b = _bucket[currency];
        uint64 finish = b.streamFinish;
        uint64 upTo = uint64(block.timestamp) < finish ? uint64(block.timestamp) : finish;
        if (upTo <= b.lastCheckpoint) return b.magnifiedPerShare;
        uint256 shares = totalShares;
        if (shares == 0 || shares < minSharesForDistribution) return b.magnifiedPerShare;
        uint256 grossMag = uint256(upTo - b.lastCheckpoint) * b.streamRate + b.remainderMag;
        uint256 vested = grossMag / MAGNITUDE;
        if (vested == 0) return b.magnifiedPerShare;
        return b.magnifiedPerShare + (vested * MAGNITUDE) / shares;
    }

    /// @dev The sole accounting delta from Carbon. Preserve exactly the magnified unvested budget:
    ///      remainingTime*oldRate + oldRemainder + addition*MAGNITUDE.
    ///      Carbon rounded rate dust UP into whole pending units while retaining a fractional
    ///      remainder. Later top-ups could promise more tokens than had arrived. No whole pending
    ///      unit is created here: rate*window + remainder equals the exact budget by construction.
    function _arm(address currency, uint256 addition) internal {
        Bucket storage b = _bucket[currency];
        uint256 nowTs = block.timestamp;
        uint256 remainingTime = b.streamFinish > nowTs ? b.streamFinish - nowTs : 0;
        uint256 remainingMag = remainingTime * b.streamRate;
        uint256 remaining = remainingMag / MAGNITUDE;
        uint256 total = addition + remaining;
        if (total == 0) return;
        // Preserve Carbon's weighted re-lock policy; only dust accounting changes.
        uint256 window = (remaining * remainingTime + addition * STREAM_WINDOW) / total;
        if (window == 0) window = 1;
        uint256 budgetMag = addition * MAGNITUDE + remainingMag + b.remainderMag;
        b.streamRate = budgetMag / window;
        b.remainderMag = budgetMag % window;
        b.streamFinish = uint64(nowTs + window);
        b.lastCheckpoint = uint64(nowTs);
    }

    function credit(address currency, uint256 amount) external {
        if (msg.sender != feedOf[currency]) revert OnlyFeed();
        _checkpoint(currency);
        Bucket storage b = _bucket[currency];
        uint256 total = amount + b.pending;
        if (total == 0) return;
        uint256 shares = totalShares;
        if (shares == 0 || shares < minSharesForDistribution) {
            b.pending = total;
            return;
        }
        b.pending = 0;
        _arm(currency, total);
        emit PayoutsAdded(currency, total, b.magnifiedPerShare);
    }

    function flush(address currency) external {
        if (!isMarketCurrency[currency]) revert NotAMarket(currency);
        _checkpoint(currency);
        Bucket storage b = _bucket[currency];
        uint256 carry = b.pending;
        if (carry == 0) return;
        uint256 shares = totalShares;
        if (shares == 0 || shares < minSharesForDistribution) return;
        b.pending = 0;
        _arm(currency, carry);
        emit PayoutsAdded(currency, carry, b.magnifiedPerShare);
    }

    function setBalance(address account, uint256 newBalance) external onlyShareToken {
        _checkpointAll();
        if (excluded[account]) {
            if (shareOf[account] != 0) _setShares(account, 0);
            return;
        }
        _setShares(account, newBalance);
    }

    function setExcluded(address account, bool isExcluded) external {
        if (msg.sender != controller) revert OnlyController();
        _checkpointAll();
        excluded[account] = isExcluded;
        if (isExcluded && shareOf[account] != 0) _setShares(account, 0);
        emit ExcludedSet(account, isExcluded);
    }

    function renounceAccrual() external {
        _checkpointAll();
        if (excluded[msg.sender]) revert AlreadyExcluded();
        excluded[msg.sender] = true;
        if (shareOf[msg.sender] != 0) _setShares(msg.sender, 0);
        emit ExcludedSet(msg.sender, true);
    }

    function _setShares(address account, uint256 newShares) internal {
        uint256 old = shareOf[account];
        if (newShares == old) return;
        uint256 n = _currencies.length;
        if (newShares > old) {
            uint256 d = newShares - old;
            totalShares += d;
            for (uint256 i; i < n; ++i) {
                _corrections[_currencies[i]][account] -= int256(_bucket[_currencies[i]].magnifiedPerShare * d);
            }
        } else {
            uint256 d = old - newShares;
            totalShares -= d;
            for (uint256 i; i < n; ++i) {
                _corrections[_currencies[i]][account] += int256(_bucket[_currencies[i]].magnifiedPerShare * d);
            }
        }
        shareOf[account] = newShares;
        if (newShares >= minShareForQueue) _enqueue(account);
        else if (newShares == 0) _dequeue(account);
    }

    function withdraw() external nonReentrant returns (uint256 paidCount) {
        _checkpointAll();
        uint256 owed;
        for (uint256 i; i < _currencies.length; ++i) {
            address c = _currencies[i];
            uint256 amount = withdrawableOf(msg.sender, c);
            if (amount == 0) continue;
            ++owed;
            if (_pay(msg.sender, c, amount)) ++paidCount;
        }
        if (owed == 0 || paidCount == 0) revert NothingToWithdraw();
    }

    function withdrawOne(address currency) external nonReentrant returns (uint256) {
        if (!isMarketCurrency[currency]) revert NotAMarket(currency);
        _checkpoint(currency);
        uint256 amount = withdrawableOf(msg.sender, currency);
        if (amount == 0) revert NothingToWithdraw();
        if (!_pay(msg.sender, currency, amount)) revert NothingToWithdraw();
        return amount;
    }

    function processBatch(uint256 maxAccounts) external nonReentrant returns (uint256 sentCount) {
        _checkpointAll();
        uint256 len = _queue.length;
        if (len == 0 || maxAccounts == 0) return 0;
        if (maxAccounts > len) maxAccounts = len;
        uint256 n = _currencies.length;
        uint256 i = cursor;
        for (uint256 k; k < maxAccounts; ++k) {
            if (i >= len) i = 0;
            address account = _queue[i];
            for (uint256 j; j < n; ++j) {
                address c = _currencies[j];
                uint256 amount = withdrawableOf(account, c);
                if (amount != 0 && amount >= minPushPayout[c]) {
                    if (_pay(account, c, amount)) ++sentCount;
                }
            }
            unchecked {
                ++i;
            }
        }
        cursor = i >= len ? 0 : i;
    }

    function _pay(address to, address currency, uint256 amount) internal returns (bool) {
        Bucket storage b = _bucket[currency];
        _withdrawn[currency][to] += amount;
        b.totalWithdrawn += amount;
        (bool ok, bytes memory ret) =
            currency.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) {
            emit PayoutSent(to, currency, amount);
            return true;
        }
        _withdrawn[currency][to] -= amount;
        b.totalWithdrawn -= amount;
        emit PayoutSendFailed(to, currency, amount);
        return false;
    }

    function _enqueue(address account) internal {
        if (_queueIndexPlusOne[account] != 0) return;
        _queue.push(account);
        _queueIndexPlusOne[account] = _queue.length;
    }

    function _dequeue(address account) internal {
        uint256 idxPlusOne = _queueIndexPlusOne[account];
        if (idxPlusOne == 0) return;
        uint256 idx = idxPlusOne - 1;
        uint256 last = _queue.length - 1;
        if (idx != last) {
            address moved = _queue[last];
            _queue[idx] = moved;
            _queueIndexPlusOne[moved] = idx + 1;
        }
        _queue.pop();
        delete _queueIndexPlusOne[account];
    }
}
