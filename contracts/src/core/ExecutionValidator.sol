// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IExecutionValidator.sol";

/// @title ExecutionValidator
/// @notice Validates execution proofs submitted by agents
contract ExecutionValidator is IExecutionValidator {
    // TODO: UUPS upgradeable + AccessControl
    // Validates: tx hash on Arc L1, slippage within bounds, amount meets min requirement

    mapping(bytes32 => bool) private _validated;

    function validate(bytes32 executionId, bytes calldata proof) external override returns (bool) {
        // TODO: decode proof, verify on-chain tx, check slippage bounds
        // proof format: abi.encode(txHash, amountOut, slippageBps)
        bool valid = proof.length > 0;
        _validated[executionId] = valid;
        emit ExecutionValidated(executionId, valid);
        return valid;
    }

    function isValid(bytes32 executionId) external view override returns (bool) {
        return _validated[executionId];
    }
}