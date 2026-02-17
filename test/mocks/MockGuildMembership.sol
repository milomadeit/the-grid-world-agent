// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockGuildMembership {
  mapping(address => bool) public anyGuildMember;
  mapping(uint256 => mapping(address => bool)) public guildMember;

  function setAnyMember(address account, bool isMember) external {
    anyGuildMember[account] = isMember;
  }

  function setGuildMember(uint256 guildId, address account, bool isMember) external {
    guildMember[guildId][account] = isMember;
  }

  function isInAnyGuild(address account) external view returns (bool) {
    return anyGuildMember[account];
  }

  function isInGuild(uint256 guildId, address account) external view returns (bool) {
    return guildMember[guildId][account];
  }
}
