// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockBonusHook {
  mapping(address => uint256) public creationCalls;
  mapping(address => uint256) public inviteCalls;

  function notifyGuildCreation(address creator) external {
    creationCalls[creator] += 1;
  }

  function notifyGuildInvite(address inviter) external {
    inviteCalls[inviter] += 1;
  }
}
