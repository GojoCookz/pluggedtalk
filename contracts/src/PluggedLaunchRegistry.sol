// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Prevents duplicate canonical ticker + name + economics within one Plugged factory.
/// @dev The immutable factory must derive settingsHash from validated economics, deploy and
///      register atomically. No public reservation to front-run. This cannot police other factories.
contract PluggedLaunchRegistry {
    address public immutable FACTORY;
    mapping(bytes32 => address) public tokenFor;
    error Unauthorized();
    error InvalidTicker();
    error InvalidName();
    error InvalidLaunch();
    error DuplicateLaunch(bytes32 key, address token);
    event Registered(
        bytes32 indexed key, address indexed token, string ticker, string name, bytes32 settingsHash
    );

    constructor(address factory) {
        if (factory == address(0)) revert InvalidLaunch();
        FACTORY = factory;
    }

    function canonicalTicker(string memory symbol) public pure returns (string memory) {
        bytes memory ticker = bytes(symbol);
        if (ticker.length == 0 || ticker.length > 12) revert InvalidTicker();
        for (uint256 i; i < ticker.length; ++i) {
            uint8 c = uint8(ticker[i]);
            if (c >= 97 && c <= 122) ticker[i] = bytes1(c - 32);
            else if (!((c >= 65 && c <= 90) || (c >= 48 && c <= 57))) revert InvalidTicker();
        }
        return string(ticker);
    }

    /// @dev ASCII case and whitespace normalize; non-ASCII UTF-8 bytes remain distinct.
    function canonicalName(string memory name) public pure returns (string memory) {
        bytes memory input = bytes(name);
        if (input.length == 0 || input.length > 256) revert InvalidName();
        bytes memory buffer = new bytes(input.length);
        uint256 length;
        bool space;
        for (uint256 i; i < input.length; ++i) {
            uint8 c = uint8(input[i]);
            if (c == 32 || (c >= 9 && c <= 13)) {
                space = length > 0;
                continue;
            }
            if (space) buffer[length++] = bytes1(uint8(32));
            space = false;
            buffer[length++] = c >= 97 && c <= 122 ? bytes1(c - 32) : input[i];
        }
        if (length == 0) revert InvalidName();
        bytes memory result = new bytes(length);
        for (uint256 i; i < length; ++i) {
            result[i] = buffer[i];
        }
        return string(result);
    }

    function fingerprint(string memory ticker, string memory name, bytes32 settingsHash)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(canonicalTicker(ticker), canonicalName(name), settingsHash));
    }

    function register(string calldata ticker, string calldata name, bytes32 settingsHash, address token)
        external
    {
        if (msg.sender != FACTORY) revert Unauthorized();
        if (token.code.length == 0 || settingsHash == bytes32(0)) revert InvalidLaunch();
        bytes32 key = fingerprint(ticker, name, settingsHash);
        if (tokenFor[key] != address(0)) revert DuplicateLaunch(key, tokenFor[key]);
        tokenFor[key] = token;
        emit Registered(key, token, canonicalTicker(ticker), canonicalName(name), settingsHash);
    }
}
