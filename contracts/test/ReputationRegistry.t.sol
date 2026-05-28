// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./utils/BaseTest.sol";
import "../src/core/ReputationRegistry.sol";

contract ReputationRegistryTest is BaseTest {
    ReputationRegistry public registry;

    function setUp() public override {
        super.setUp();
        registry = new ReputationRegistry();
    }

    function test_initial_score() public view {
        // TODO: assert initial score == INITIAL_SCORE for any address
    }

    function test_update_score_positive() public {
        // TODO: update score +100, assert new score
    }

    function test_update_score_cannot_go_below_zero() public {
        // TODO: slash to 0, assert score == 0, not underflow
    }

    function test_slash() public {
        // TODO: test slash reduces score correctly
    }
}