// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DirectiveRegistry} from "../contracts/DirectiveRegistry.sol";
import {MockGuildMembership} from "./mocks/MockGuildMembership.sol";
import {MinimalTest} from "./MinimalTest.sol";

contract DirectiveRegistryTest is MinimalTest {
  DirectiveRegistry internal directiveRegistry;
  MockGuildMembership internal guildMembership;

  address internal alice = address(0xA11CE);
  address internal bob = address(0xB0B);
  address internal carol = address(0xCA11);

  function setUp() public {
    directiveRegistry = new DirectiveRegistry();
    guildMembership = new MockGuildMembership();
    directiveRegistry.setGuildRegistry(address(guildMembership));
  }

  function testSubmitSoloDirectiveCreatesOpenDirective() public {
    vm.prank(alice);
    uint256 directiveId = directiveRegistry.submitSoloDirective(
      1001,
      "Build a bridge between east and west",
      3,
      10,
      20,
      24
    );

    DirectiveRegistry.Directive memory d = directiveRegistry.directiveInfo(directiveId);
    assertEq(d.id, directiveId, "directive id mismatch");
    assertEq(uint256(d.kind), 0, "kind should be solo");
    assertEq(d.guildId, 0, "solo directive should have guildId 0");
    assertEq(d.proposer, alice, "proposer mismatch");
    assertEq(d.proposerAgentTokenId, 1001, "proposer token id mismatch");
    assertEq(d.objective, "Build a bridge between east and west", "objective mismatch");
    assertEq(uint256(d.agentsNeeded), 3, "agents needed mismatch");
    assertEq(int256(d.x), int256(10), "x coordinate mismatch");
    assertEq(int256(d.z), int256(20), "z coordinate mismatch");
    assertEq(uint256(d.status), 0, "status should start OPEN");
    assertEq(uint256(d.yesVotes), 0, "yes votes should start at 0");
    assertEq(uint256(d.noVotes), 0, "no votes should start at 0");
  }

  function testVoteAutoActivatesWhenThresholdReached() public {
    vm.prank(alice);
    uint256 directiveId = directiveRegistry.submitSoloDirective(
      1001,
      "Extend road to northern district",
      2,
      0,
      0,
      24
    );

    vm.prank(bob);
    directiveRegistry.vote(directiveId, 2001, true);

    DirectiveRegistry.Directive memory afterFirstVote = directiveRegistry.directiveInfo(directiveId);
    assertEq(uint256(afterFirstVote.yesVotes), 1, "first yes vote should be counted");
    assertEq(uint256(afterFirstVote.status), 0, "status should remain OPEN before threshold");

    vm.prank(carol);
    directiveRegistry.vote(directiveId, 3001, true);

    DirectiveRegistry.Directive memory afterSecondVote = directiveRegistry.directiveInfo(directiveId);
    assertEq(uint256(afterSecondVote.yesVotes), 2, "second yes vote should be counted");
    assertEq(uint256(afterSecondVote.status), 1, "status should become ACTIVE at threshold");
  }

  function testCannotVoteTwiceOnSameDirective() public {
    vm.prank(alice);
    uint256 directiveId = directiveRegistry.submitSoloDirective(
      1001,
      "Create a central plaza",
      2,
      5,
      5,
      24
    );

    vm.prank(bob);
    directiveRegistry.vote(directiveId, 2001, true);

    vm.prank(bob);
    vm.expectRevert();
    directiveRegistry.vote(directiveId, 2001, true);
  }

  function testSoloDirectiveRateLimitTenPerDay() public {
    for (uint256 i = 0; i < 10; i++) {
      vm.prank(alice);
      directiveRegistry.submitSoloDirective(
        1001,
        "Grow district",
        1,
        0,
        0,
        24
      );
    }

    vm.prank(alice);
    vm.expectRevert();
    directiveRegistry.submitSoloDirective(
      1001,
      "Grow district",
      1,
      0,
      0,
      24
    );
  }

  function testGuildDirectiveRequiresMembership() public {
    vm.prank(alice);
    vm.expectRevert();
    directiveRegistry.submitGuildDirective(
      1,
      1001,
      "Guild-only project",
      2,
      1,
      1,
      24
    );

    guildMembership.setGuildMember(1, alice, true);

    vm.prank(alice);
    uint256 directiveId = directiveRegistry.submitGuildDirective(
      1,
      1001,
      "Guild-only project",
      2,
      1,
      1,
      24
    );

    DirectiveRegistry.Directive memory d = directiveRegistry.directiveInfo(directiveId);
    assertEq(uint256(d.kind), 1, "kind should be guild");
    assertEq(d.guildId, 1, "guildId should be persisted");
  }

  function testGuildDirectiveHourlyRateLimit() public {
    guildMembership.setGuildMember(7, alice, true);

    for (uint256 i = 0; i < 10; i++) {
      vm.prank(alice);
      directiveRegistry.submitGuildDirective(
        7,
        1001,
        "Guild expansion",
        2,
        3,
        4,
        24
      );
    }

    vm.prank(alice);
    vm.expectRevert();
    directiveRegistry.submitGuildDirective(
      7,
      1001,
      "Guild expansion",
      2,
      3,
      4,
      24
    );
  }

  function testExpiredDirectiveCannotBeVoted() public {
    vm.prank(alice);
    uint256 directiveId = directiveRegistry.submitSoloDirective(
      1001,
      "Short lived objective",
      2,
      0,
      0,
      1
    );

    vm.warp(block.timestamp + 1 hours + 1);

    DirectiveRegistry.Directive memory d = directiveRegistry.directiveInfo(directiveId);
    assertEq(uint256(d.status), 3, "status should resolve to EXPIRED");

    vm.prank(bob);
    vm.expectRevert();
    directiveRegistry.vote(directiveId, 2001, true);
  }
}
