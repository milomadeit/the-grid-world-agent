// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface Vm {
  function prank(address) external;
  function startPrank(address) external;
  function stopPrank() external;
  function expectRevert() external;
  function warp(uint256) external;
}

abstract contract MinimalTest {
  Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

  error AssertionFailed(string message);

  function _fail(string memory message) internal pure {
    revert AssertionFailed(message);
  }

  function assertTrue(bool condition, string memory message) internal pure {
    if (!condition) _fail(message);
  }

  function assertEq(uint256 a, uint256 b, string memory message) internal pure {
    if (a != b) _fail(message);
  }

  function assertEq(int256 a, int256 b, string memory message) internal pure {
    if (a != b) _fail(message);
  }

  function assertEq(address a, address b, string memory message) internal pure {
    if (a != b) _fail(message);
  }

  function assertEq(bool a, bool b, string memory message) internal pure {
    if (a != b) _fail(message);
  }

  function assertEq(string memory a, string memory b, string memory message) internal pure {
    if (keccak256(bytes(a)) != keccak256(bytes(b))) _fail(message);
  }
}
