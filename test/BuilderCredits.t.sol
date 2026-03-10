// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BuilderCredits} from "../contracts/BuilderCredits.sol";
import {MockGuildMembership} from "./mocks/MockGuildMembership.sol";
import {MinimalTest} from "./MinimalTest.sol";

contract BuilderCreditsTest is MinimalTest {
  BuilderCredits internal credits;
  MockGuildMembership internal guildMembership;

  address internal alice = address(0xA11CE);
  address internal bob = address(0xB0B);

  function setUp() public {
    credits = new BuilderCredits();
    guildMembership = new MockGuildMembership();

    credits.setGuildRegistry(address(guildMembership));
    credits.setGuildEventSource(address(this));
    credits.setSpender(address(this), true);
  }

  function testRegisterAgentGetsInitialGrant() public {
    credits.registerAgent(alice);

    (bool registered,, , uint256 balance,,) = credits.accountState(alice);
    assertEq(registered, true, "agent should be registered");
    assertEq(balance, 1000, "initial grant should be 1000");
  }

  function testClaimDailySoloCreditsAndCooldown() public {
    credits.registerAgent(alice);

    vm.prank(alice);
    uint256 amount = credits.claimDailyCredits();
    assertEq(amount, 500, "solo daily amount should be 500");

    (, , , uint256 balance,,) = credits.accountState(alice);
    assertEq(balance, 1500, "balance should include initial + daily");

    vm.prank(alice);
    vm.expectRevert();
    credits.claimDailyCredits();
  }

  function testClaimDailyGuildCredits() public {
    credits.registerAgent(alice);
    guildMembership.setAnyMember(alice, true);

    vm.prank(alice);
    uint256 amount = credits.claimDailyCredits();
    assertEq(amount, 750, "guild member daily amount should be 750");

    (, , , uint256 balance,,) = credits.accountState(alice);
    assertEq(balance, 1750, "balance should include initial + guild daily");
  }

  function testClaimBonusHasGlobal24hCooldown() public {
    credits.registerAgent(alice);

    credits.notifyGuildInvite(alice);
    credits.notifyGuildCreation(alice);

    vm.prank(alice);
    uint256 firstClaim = credits.claimBonus(BuilderCredits.BonusType.GuildInvite);
    assertEq(firstClaim, 250, "bonus claim should return bonus amount");

    vm.prank(alice);
    vm.expectRevert();
    credits.claimBonus(BuilderCredits.BonusType.GuildCreation);

    vm.warp(block.timestamp + 1 days + 1);

    vm.prank(alice);
    uint256 secondClaim = credits.claimBonus(BuilderCredits.BonusType.GuildCreation);
    assertEq(secondClaim, 250, "second bonus should succeed after cooldown");
  }

  function testConsumeCreditsRequiresAuthorizedSpender() public {
    credits.registerAgent(alice);
    credits.consumeCredits(alice, 400);

    (, , , uint256 balanceAfterConsume,,) = credits.accountState(alice);
    assertEq(balanceAfterConsume, 600, "consume should reduce credits");

    vm.prank(bob);
    vm.expectRevert();
    credits.consumeCredits(alice, 1);
  }
}
