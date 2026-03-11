// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SnipeTarget {
    address public owner;
    mapping(bytes32 => uint256) public activationBlock;
    mapping(bytes32 => address) public sniped;
    mapping(bytes32 => uint256) public snipedBlock;

    constructor() {
        owner = msg.sender;
    }

    function activateTarget(bytes32 runId) external {
        require(msg.sender == owner, "Not owner");
        require(activationBlock[runId] == 0, "Already active");
        activationBlock[runId] = block.number;
    }

    function snipe(bytes32 runId) external {
        require(activationBlock[runId] > 0, "Not active");
        require(sniped[runId] == address(0), "Already sniped");
        sniped[runId] = msg.sender;
        snipedBlock[runId] = block.number;
    }
}
