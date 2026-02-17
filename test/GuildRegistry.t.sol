// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GuildRegistry} from "../contracts/GuildRegistry.sol";
import {MockBonusHook} from "./mocks/MockBonusHook.sol";
import {MinimalTest} from "./MinimalTest.sol";

contract GuildRegistryTest is MinimalTest {
  GuildRegistry internal guildRegistry;
  MockBonusHook internal bonusHook;

  address internal captain = address(0xA11CE);
  address internal lieutenant = address(0xB0B);
  address internal recruit = address(0xC0DE);
  address internal outsider = address(0xDEAD);

  function setUp() public {
    guildRegistry = new GuildRegistry();
    bonusHook = new MockBonusHook();
    guildRegistry.setBonusHook(address(bonusHook));
  }

  function testCreateGuildStoresFoundersAndMembers() public {
    vm.prank(captain);
    uint256 guildId = guildRegistry.createGuild("Builders Union", lieutenant, 101, 102);

    assertEq(guildId, 1, "guild id should start at 1");

    (GuildRegistry.Guild memory guild, address[] memory members, uint256[] memory tokenIds) = guildRegistry.guildInfo(guildId);
    assertEq(guild.id, guildId, "guild id mismatch");
    assertEq(guild.name, "Builders Union", "guild name mismatch");
    assertEq(guild.captain, captain, "captain mismatch");
    assertEq(guild.lieutenant, lieutenant, "lieutenant mismatch");
    assertEq(uint256(guild.memberCount), 2, "founders should be members");

    assertEq(members.length, 2, "member list length mismatch");
    assertEq(tokenIds.length, 2, "token list length mismatch");
    assertEq(members[0], captain, "captain should be first member");
    assertEq(members[1], lieutenant, "lieutenant should be second member");
    assertEq(tokenIds[0], 101, "captain token id mismatch");
    assertEq(tokenIds[1], 102, "lieutenant token id mismatch");

    assertEq(guildRegistry.reputationBoostByAddress(captain), int256(5), "creation reputation boost mismatch");
    assertEq(bonusHook.creationCalls(captain), 1, "bonus hook creation call mismatch");
  }

  function testOnlyOfficerCanSendInvite() public {
    vm.prank(captain);
    uint256 guildId = guildRegistry.createGuild("Core Team", lieutenant, 101, 102);

    vm.prank(outsider);
    vm.expectRevert();
    guildRegistry.sendInvite(guildId, recruit);
  }

  function testOfficerInviteAndAcceptFlow() public {
    vm.prank(captain);
    uint256 guildId = guildRegistry.createGuild("Frontier Guild", lieutenant, 101, 102);

    vm.prank(lieutenant);
    uint256 inviteId = guildRegistry.sendInvite(guildId, recruit);
    assertEq(inviteId, 1, "first invite id should be 1");

    vm.prank(recruit);
    guildRegistry.acceptInvite(inviteId, 103);

    (GuildRegistry.Guild memory guild, address[] memory members, uint256[] memory tokenIds) = guildRegistry.guildInfo(guildId);
    assertEq(uint256(guild.memberCount), 3, "member count should increase");
    assertEq(members.length, 3, "member array length should increase");
    assertEq(tokenIds.length, 3, "token id array length should increase");
    assertEq(members[2], recruit, "recruit should be appended");
    assertEq(tokenIds[2], 103, "recruit token id mismatch");

    assertEq(bonusHook.inviteCalls(lieutenant), 1, "bonus hook invite call mismatch");
  }

  function testGuildIdsRemainUniqueAfterRemoveAndRejoin() public {
    vm.prank(captain);
    uint256 guildId = guildRegistry.createGuild("Repeatable", lieutenant, 101, 102);

    vm.prank(captain);
    uint256 invite1 = guildRegistry.sendInvite(guildId, recruit);
    vm.prank(recruit);
    guildRegistry.acceptInvite(invite1, 103);

    vm.prank(captain);
    guildRegistry.removeMember(guildId, recruit);

    vm.prank(captain);
    uint256 invite2 = guildRegistry.sendInvite(guildId, recruit);
    vm.prank(recruit);
    guildRegistry.acceptInvite(invite2, 104);

    uint256[] memory guildIds = guildRegistry.guildIdsOf(recruit);
    assertEq(guildIds.length, 1, "guild id list should not duplicate on rejoin");
    assertEq(guildIds[0], guildId, "guild id mismatch");
  }
}
