// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// TODO: import "forge-std/Test.sol";
// import "../../src/mocks/MockUSDC.sol";

/// @notice Shared base for all Intent test contracts
abstract contract BaseTest {
    // TODO: extend Test
    // MockUSDC public usdc;
    // address public deployer = makeAddr("deployer");
    // address public user = makeAddr("user");
    // address public agent = makeAddr("agent");
    // address public validator = makeAddr("validator");

    function setUp() public virtual {
        // TODO: deploy MockUSDC, seed balances
    }
}