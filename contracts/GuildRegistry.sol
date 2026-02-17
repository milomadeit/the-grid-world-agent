// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * GuildRegistry
 * - Testnet-first guild creation + management for OpGrid.
 * - Requires captain + lieutenant at creation time.
 * - Captain or lieutenant can invite new members.
 * - Tracks per-member agent token IDs (for ERC-8004 identity linkage).
 */
interface IGuildBonusHook {
  function notifyGuildCreation(address creator) external;
  function notifyGuildInvite(address inviter) external;
}

contract GuildRegistry {
  error NotOwner();
  error InvalidAddress();
  error InvalidName();
  error InvalidRole();
  error GuildNotFound();
  error GuildInactive();
  error NotGuildOfficer();
  error AlreadyMember();
  error NotMember();
  error InviteNotFound();
  error InviteNotPending();
  error NotInvitee();
  error DuplicateGuildName();
  error DuplicateInvite();
  error GuildFull();

  enum InviteStatus {
    None,
    Pending,
    Accepted,
    Declined,
    Revoked
  }

  struct Guild {
    uint256 id;
    string name;
    address captain;
    address lieutenant;
    uint64 createdAt;
    bool active;
    uint32 memberCount;
  }

  struct Member {
    address account;
    uint256 agentTokenId;
    uint64 joinedAt;
  }

  struct Invite {
    uint256 id;
    uint256 guildId;
    address inviter;
    address invitee;
    uint64 createdAt;
    InviteStatus status;
  }

  address public owner;
  uint256 public nextGuildId = 1;
  uint256 public nextInviteId = 1;
  uint256 public maxMembersPerGuild = 500;
  int256 public guildCreationReputationBoost = 5;
  IGuildBonusHook public bonusHook;

  // Guild id => guild metadata
  mapping(uint256 => Guild) private _guilds;
  // Guild id => member list
  mapping(uint256 => Member[]) private _guildMembers;
  // Guild id => account => is member
  mapping(uint256 => mapping(address => bool)) private _isMember;
  // Account => guild ids
  mapping(address => uint256[]) private _guildIdsByMember;
  // Account => guild id => whether guild id already linked in _guildIdsByMember
  mapping(address => mapping(uint256 => bool)) private _guildIdLinked;
  // Guild id => account => agent token id
  mapping(uint256 => mapping(address => uint256)) private _agentTokenIdByGuildMember;
  // Guild name hash => used
  mapping(bytes32 => bool) private _guildNameTaken;
  // Invite id => invite
  mapping(uint256 => Invite) private _invites;
  // Guild id => invitee => pending invite already exists
  mapping(uint256 => mapping(address => bool)) private _hasPendingInvite;
  // Lightweight onchain reputation delta tracked by guild actions
  mapping(address => int256) public reputationBoostByAddress;

  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
  event GuildCreated(
    uint256 indexed guildId,
    string name,
    address indexed captain,
    address indexed lieutenant,
    uint256 captainAgentTokenId,
    uint256 lieutenantAgentTokenId
  );
  event GuildInviteSent(uint256 indexed inviteId, uint256 indexed guildId, address indexed inviter, address invitee);
  event GuildInviteRevoked(uint256 indexed inviteId, uint256 indexed guildId);
  event GuildInviteDeclined(uint256 indexed inviteId, uint256 indexed guildId, address indexed invitee);
  event GuildInviteAccepted(uint256 indexed inviteId, uint256 indexed guildId, address indexed invitee, uint256 agentTokenId);
  event GuildMemberRemoved(uint256 indexed guildId, address indexed member);
  event GuildOfficerUpdated(uint256 indexed guildId, address indexed captain, address indexed lieutenant);
  event GuildActivationUpdated(uint256 indexed guildId, bool active);
  event BonusHookUpdated(address indexed bonusHook);
  event GuildCreationReputationBoostUpdated(int256 newBoost);
  event MaxMembersPerGuildUpdated(uint256 maxMembersPerGuild);
  event ReputationBoostApplied(address indexed account, int256 delta, int256 newTotalBoost);

  constructor() {
    owner = msg.sender;
    emit OwnershipTransferred(address(0), msg.sender);
  }

  modifier onlyOwner() {
    if (msg.sender != owner) revert NotOwner();
    _;
  }

  function transferOwnership(address newOwner) external onlyOwner {
    if (newOwner == address(0)) revert InvalidAddress();
    address previousOwner = owner;
    owner = newOwner;
    emit OwnershipTransferred(previousOwner, newOwner);
  }

  function setBonusHook(address hook) external onlyOwner {
    bonusHook = IGuildBonusHook(hook);
    emit BonusHookUpdated(hook);
  }

  function setGuildCreationReputationBoost(int256 boost) external onlyOwner {
    guildCreationReputationBoost = boost;
    emit GuildCreationReputationBoostUpdated(boost);
  }

  function setMaxMembersPerGuild(uint256 maxMembers) external onlyOwner {
    if (maxMembers < 2) revert InvalidRole();
    maxMembersPerGuild = maxMembers;
    emit MaxMembersPerGuildUpdated(maxMembers);
  }

  function createGuild(
    string calldata name,
    address lieutenant,
    uint256 captainAgentTokenId,
    uint256 lieutenantAgentTokenId
  ) external returns (uint256 guildId) {
    if (bytes(name).length == 0 || bytes(name).length > 64) revert InvalidName();
    if (lieutenant == address(0)) revert InvalidAddress();
    if (lieutenant == msg.sender) revert InvalidRole();

    bytes32 nameHash = keccak256(bytes(name));
    if (_guildNameTaken[nameHash]) revert DuplicateGuildName();
    _guildNameTaken[nameHash] = true;

    guildId = nextGuildId++;
    Guild storage g = _guilds[guildId];
    g.id = guildId;
    g.name = name;
    g.captain = msg.sender;
    g.lieutenant = lieutenant;
    g.createdAt = uint64(block.timestamp);
    g.active = true;

    _addMember(guildId, msg.sender, captainAgentTokenId);
    _addMember(guildId, lieutenant, lieutenantAgentTokenId);

    int256 nextRep = reputationBoostByAddress[msg.sender] + guildCreationReputationBoost;
    reputationBoostByAddress[msg.sender] = nextRep;

    emit GuildCreated(guildId, name, msg.sender, lieutenant, captainAgentTokenId, lieutenantAgentTokenId);
    emit ReputationBoostApplied(msg.sender, guildCreationReputationBoost, nextRep);

    if (address(bonusHook) != address(0)) {
      try bonusHook.notifyGuildCreation(msg.sender) {} catch {}
    }
  }

  function sendInvite(uint256 guildId, address invitee) external returns (uint256 inviteId) {
    Guild storage g = _guilds[guildId];
    if (g.id == 0) revert GuildNotFound();
    if (!g.active) revert GuildInactive();
    if (!_isGuildOfficer(guildId, msg.sender)) revert NotGuildOfficer();
    if (invitee == address(0)) revert InvalidAddress();
    if (_isMember[guildId][invitee]) revert AlreadyMember();
    if (_hasPendingInvite[guildId][invitee]) revert DuplicateInvite();
    if (g.memberCount >= maxMembersPerGuild) revert GuildFull();

    inviteId = nextInviteId++;
    _invites[inviteId] = Invite({
      id: inviteId,
      guildId: guildId,
      inviter: msg.sender,
      invitee: invitee,
      createdAt: uint64(block.timestamp),
      status: InviteStatus.Pending
    });
    _hasPendingInvite[guildId][invitee] = true;

    emit GuildInviteSent(inviteId, guildId, msg.sender, invitee);

    if (address(bonusHook) != address(0)) {
      try bonusHook.notifyGuildInvite(msg.sender) {} catch {}
    }
  }

  function revokeInvite(uint256 inviteId) external {
    Invite storage inv = _invites[inviteId];
    if (inv.id == 0) revert InviteNotFound();
    if (inv.status != InviteStatus.Pending) revert InviteNotPending();
    if (!_isGuildOfficer(inv.guildId, msg.sender) && inv.inviter != msg.sender) revert NotGuildOfficer();

    inv.status = InviteStatus.Revoked;
    _hasPendingInvite[inv.guildId][inv.invitee] = false;

    emit GuildInviteRevoked(inviteId, inv.guildId);
  }

  function declineInvite(uint256 inviteId) external {
    Invite storage inv = _invites[inviteId];
    if (inv.id == 0) revert InviteNotFound();
    if (inv.status != InviteStatus.Pending) revert InviteNotPending();
    if (inv.invitee != msg.sender) revert NotInvitee();

    inv.status = InviteStatus.Declined;
    _hasPendingInvite[inv.guildId][msg.sender] = false;

    emit GuildInviteDeclined(inviteId, inv.guildId, msg.sender);
  }

  function acceptInvite(uint256 inviteId, uint256 agentTokenId) external {
    Invite storage inv = _invites[inviteId];
    if (inv.id == 0) revert InviteNotFound();
    if (inv.status != InviteStatus.Pending) revert InviteNotPending();
    if (inv.invitee != msg.sender) revert NotInvitee();

    Guild storage g = _guilds[inv.guildId];
    if (g.id == 0) revert GuildNotFound();
    if (!g.active) revert GuildInactive();
    if (_isMember[inv.guildId][msg.sender]) revert AlreadyMember();
    if (g.memberCount >= maxMembersPerGuild) revert GuildFull();

    inv.status = InviteStatus.Accepted;
    _hasPendingInvite[inv.guildId][msg.sender] = false;
    _addMember(inv.guildId, msg.sender, agentTokenId);

    emit GuildInviteAccepted(inviteId, inv.guildId, msg.sender, agentTokenId);
  }

  function removeMember(uint256 guildId, address member) external {
    Guild storage g = _guilds[guildId];
    if (g.id == 0) revert GuildNotFound();
    if (!_isGuildOfficer(guildId, msg.sender)) revert NotGuildOfficer();
    if (!_isMember[guildId][member]) revert NotMember();

    // Keep officer constraints explicit: set replacement first if needed.
    if (member == g.captain || member == g.lieutenant) revert InvalidRole();

    _isMember[guildId][member] = false;
    _agentTokenIdByGuildMember[guildId][member] = 0;

    Member[] storage members = _guildMembers[guildId];
    uint256 len = members.length;
    for (uint256 i = 0; i < len; i++) {
      if (members[i].account == member) {
        members[i] = members[len - 1];
        members.pop();
        break;
      }
    }

    if (g.memberCount > 0) {
      g.memberCount -= 1;
    }

    emit GuildMemberRemoved(guildId, member);
  }

  function updateGuildOfficers(
    uint256 guildId,
    address newCaptain,
    address newLieutenant
  ) external {
    Guild storage g = _guilds[guildId];
    if (g.id == 0) revert GuildNotFound();
    if (!_isGuildOfficer(guildId, msg.sender)) revert NotGuildOfficer();
    if (newCaptain == address(0) || newLieutenant == address(0)) revert InvalidAddress();
    if (newCaptain == newLieutenant) revert InvalidRole();
    if (!_isMember[guildId][newCaptain] || !_isMember[guildId][newLieutenant]) revert NotMember();

    g.captain = newCaptain;
    g.lieutenant = newLieutenant;

    emit GuildOfficerUpdated(guildId, newCaptain, newLieutenant);
  }

  function setGuildActive(uint256 guildId, bool active) external {
    Guild storage g = _guilds[guildId];
    if (g.id == 0) revert GuildNotFound();
    if (!_isGuildOfficer(guildId, msg.sender) && msg.sender != owner) revert NotGuildOfficer();
    g.active = active;
    emit GuildActivationUpdated(guildId, active);
  }

  function guildIdsOf(address account) external view returns (uint256[] memory) {
    return _guildIdsByMember[account];
  }

  function isInGuild(uint256 guildId, address account) external view returns (bool) {
    return _isMember[guildId][account];
  }

  function isInAnyGuild(address account) external view returns (bool) {
    uint256[] storage ids = _guildIdsByMember[account];
    uint256 len = ids.length;
    for (uint256 i = 0; i < len; i++) {
      Guild storage g = _guilds[ids[i]];
      if (g.active && _isMember[ids[i]][account]) {
        return true;
      }
    }
    return false;
  }

  function totalGuilds() external view returns (uint256) {
    return nextGuildId - 1;
  }

  function guildInfo(
    uint256 guildId
  )
    external
    view
    returns (
      Guild memory guild,
      address[] memory memberAccounts,
      uint256[] memory memberAgentTokenIds
    )
  {
    guild = _guilds[guildId];
    if (guild.id == 0) revert GuildNotFound();

    Member[] storage members = _guildMembers[guildId];
    uint256 len = members.length;
    memberAccounts = new address[](len);
    memberAgentTokenIds = new uint256[](len);

    for (uint256 i = 0; i < len; i++) {
      memberAccounts[i] = members[i].account;
      memberAgentTokenIds[i] = members[i].agentTokenId;
    }
  }

  function getGuildMembers(
    uint256 guildId,
    uint256 offset,
    uint256 limit
  )
    external
    view
    returns (
      address[] memory memberAccounts,
      uint256[] memory memberAgentTokenIds,
      uint256 totalMembers
    )
  {
    if (_guilds[guildId].id == 0) revert GuildNotFound();
    Member[] storage members = _guildMembers[guildId];
    totalMembers = members.length;
    if (offset >= totalMembers) {
      return (new address[](0), new uint256[](0), totalMembers);
    }

    uint256 end = offset + limit;
    if (end > totalMembers) end = totalMembers;
    uint256 size = end - offset;

    memberAccounts = new address[](size);
    memberAgentTokenIds = new uint256[](size);
    for (uint256 i = 0; i < size; i++) {
      Member storage m = members[offset + i];
      memberAccounts[i] = m.account;
      memberAgentTokenIds[i] = m.agentTokenId;
    }
  }

  /**
   * getAllGuildData
   * - Returns paged guild metadata (without member arrays).
   * - Use guildInfo(guildId) or getGuildMembers(...) for member-level data.
   */
  function getAllGuildData(
    uint256 offset,
    uint256 limit
  ) external view returns (Guild[] memory page, uint256 totalGuildCount) {
    totalGuildCount = nextGuildId - 1;
    if (offset >= totalGuildCount) {
      return (new Guild[](0), totalGuildCount);
    }

    uint256 end = offset + limit;
    if (end > totalGuildCount) end = totalGuildCount;
    uint256 size = end - offset;
    page = new Guild[](size);

    for (uint256 i = 0; i < size; i++) {
      page[i] = _guilds[offset + i + 1];
    }
  }

  function getInvite(uint256 inviteId) external view returns (Invite memory) {
    Invite memory inv = _invites[inviteId];
    if (inv.id == 0) revert InviteNotFound();
    return inv;
  }

  function _addMember(uint256 guildId, address account, uint256 agentTokenId) internal {
    if (_isMember[guildId][account]) revert AlreadyMember();
    _isMember[guildId][account] = true;
    _agentTokenIdByGuildMember[guildId][account] = agentTokenId;
    _guildMembers[guildId].push(
      Member({
        account: account,
        agentTokenId: agentTokenId,
        joinedAt: uint64(block.timestamp)
      })
    );

    if (!_guildIdLinked[account][guildId]) {
      _guildIdsByMember[account].push(guildId);
      _guildIdLinked[account][guildId] = true;
    }
    _guilds[guildId].memberCount += 1;
  }

  function _isGuildOfficer(uint256 guildId, address account) internal view returns (bool) {
    Guild storage g = _guilds[guildId];
    return account == g.captain || account == g.lieutenant;
  }
}
