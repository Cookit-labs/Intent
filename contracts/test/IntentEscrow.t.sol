// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./utils/BaseTest.sol";
import "../src/core/IntentEscrow.sol";

contract IntentEscrowTest is BaseTest {
    IntentEscrow public escrow;

    function setUp() public override {
        super.setUp();
        // TODO: deploy escrow with mock USDC address
    }

    function test_deposit() public {
        // TODO: test USDC deposit into escrow
    }

    function test_release_to_agent() public {
        // TODO: test release to winning agent
    }

    function test_cancel_refunds_user() public {
        // TODO: test cancellation refunds user
    }

    function test_revert_double_release() public {
        // TODO: test that double release reverts
    }
}