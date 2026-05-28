// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../utils/BaseTest.sol";
import "../../src/core/IntentEscrow.sol";

contract IntentEscrowFuzzTest is BaseTest {
    IntentEscrow public escrow;

    function setUp() public override {
        super.setUp();
        // TODO: deploy escrow
    }

    function testFuzz_deposit_amount(uint256 amount) public {
        // TODO: bound amount, deposit, assert balance == amount
    }

    function testFuzz_release_preserves_total(uint256 amount, address agent) public {
        // TODO: fuzz test that release preserves accounting invariant
    }
}