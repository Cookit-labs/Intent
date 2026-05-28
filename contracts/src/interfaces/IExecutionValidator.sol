// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IExecutionValidator {
    event ExecutionValidated(bytes32 indexed executionId, bool success);
    event ExecutionRejected(bytes32 indexed executionId, string reason);

    function validate(bytes32 executionId, bytes calldata proof) external returns (bool);
    function isValid(bytes32 executionId) external view returns (bool);
}