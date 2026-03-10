// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * DirectiveRegistry
 * - Onchain directives with vote-driven activation.
 * - Solo directives: per-wallet daily submit limit.
 * - Guild directives: per-guild hourly submit limit.
 * - Status lifecycle:
 *   submit -> OPEN
 *   vote threshold reached -> ACTIVE
 *   optional -> COMPLETED / CANCELLED
 *   timeout -> EXPIRED
 */
interface IGuildMembershipRead {
  function isInGuild(uint256 guildId, address account) external view returns (bool);
}

contract DirectiveRegistry {
  error NotOwner();
  error NotAuthorized();
  error InvalidAddress();
  error InvalidArgument();
  error InvalidObjective();
  error GuildRegistryNotSet();
  error NotGuildMember();
  error DirectiveNotFound();
  error DirectiveNotVotable();
  error AlreadyVoted();
  error RateLimitExceeded(uint256 limit, uint256 used, uint256 retryAfter);
  error InvalidStatus();

  enum DirectiveKind {
    Solo,
    Guild
  }

  enum DirectiveStatus {
    Open,
    Active,
    Completed,
    Expired,
    Cancelled
  }

  struct Directive {
    uint256 id;
    DirectiveKind kind;
    uint256 guildId; // 0 for solo
    address proposer;
    uint256 proposerAgentTokenId;
    string objective;
    uint16 agentsNeeded;
    int32 x;
    int32 z;
    uint64 createdAt;
    uint64 expiresAt;
    DirectiveStatus status;
    uint32 yesVotes;
    uint32 noVotes;
  }

  address public owner;
  address public guildRegistry;

  uint256 public nextDirectiveId = 1;
  uint16 public soloDailyLimit = 10;
  uint16 public guildHourlyLimit = 10;
  uint16 public maxObjectiveLength = 280;
  uint32 public maxDurationHours = 168;

  mapping(uint256 => Directive) private _directives;
  uint256[] private _directiveIds;

  mapping(uint256 => mapping(address => bool)) public hasVoted;
  // 0 = none, 1 = yes, 2 = no
  mapping(uint256 => mapping(address => uint8)) public voteChoice;

  // wallet => day bucket => count
  mapping(address => mapping(uint64 => uint16)) private _soloSubmittedByDay;
  // guild => hour bucket => count
  mapping(uint256 => mapping(uint64 => uint16)) private _guildSubmittedByHour;

  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
  event GuildRegistryUpdated(address indexed guildRegistry);
  event LimitsUpdated(uint16 soloDailyLimit, uint16 guildHourlyLimit, uint16 maxObjectiveLength, uint32 maxDurationHours);
  event DirectiveSubmitted(
    uint256 indexed directiveId,
    DirectiveKind indexed kind,
    uint256 indexed guildId,
    address proposer,
    uint256 proposerAgentTokenId,
    string objective,
    uint16 agentsNeeded,
    int32 x,
    int32 z,
    uint64 expiresAt
  );
  event DirectiveVoted(
    uint256 indexed directiveId,
    address indexed voter,
    uint256 voterAgentTokenId,
    bool support,
    uint32 yesVotes,
    uint32 noVotes
  );
  event DirectiveActivated(uint256 indexed directiveId, uint32 yesVotes, uint16 threshold);
  event DirectiveCompleted(uint256 indexed directiveId);
  event DirectiveCancelled(uint256 indexed directiveId);
  event DirectiveExpired(uint256 indexed directiveId);

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

  function setGuildRegistry(address registry) external onlyOwner {
    guildRegistry = registry;
    emit GuildRegistryUpdated(registry);
  }

  function setLimits(
    uint16 soloDailyLimit_,
    uint16 guildHourlyLimit_,
    uint16 maxObjectiveLength_,
    uint32 maxDurationHours_
  ) external onlyOwner {
    if (soloDailyLimit_ == 0 || guildHourlyLimit_ == 0) revert InvalidArgument();
    if (maxObjectiveLength_ < 8) revert InvalidObjective();
    if (maxDurationHours_ == 0) revert InvalidArgument();

    soloDailyLimit = soloDailyLimit_;
    guildHourlyLimit = guildHourlyLimit_;
    maxObjectiveLength = maxObjectiveLength_;
    maxDurationHours = maxDurationHours_;

    emit LimitsUpdated(soloDailyLimit_, guildHourlyLimit_, maxObjectiveLength_, maxDurationHours_);
  }

  function submitSoloDirective(
    uint256 proposerAgentTokenId,
    string calldata objective,
    uint16 agentsNeeded,
    int32 x,
    int32 z,
    uint32 hoursDuration
  ) external returns (uint256 directiveId) {
    _validateSubmitArgs(objective, agentsNeeded, hoursDuration);

    uint64 dayBucket = uint64(block.timestamp / 1 days);
    uint16 used = _soloSubmittedByDay[msg.sender][dayBucket];
    if (used >= soloDailyLimit) {
      uint256 retryAfter = (uint256(dayBucket) + 1) * 1 days;
      revert RateLimitExceeded(soloDailyLimit, used, retryAfter);
    }
    _soloSubmittedByDay[msg.sender][dayBucket] = used + 1;

    directiveId = _createDirective(
      DirectiveKind.Solo,
      0,
      proposerAgentTokenId,
      objective,
      agentsNeeded,
      x,
      z,
      hoursDuration
    );
  }

  function submitGuildDirective(
    uint256 guildId,
    uint256 proposerAgentTokenId,
    string calldata objective,
    uint16 agentsNeeded,
    int32 x,
    int32 z,
    uint32 hoursDuration
  ) external returns (uint256 directiveId) {
    _validateSubmitArgs(objective, agentsNeeded, hoursDuration);
    if (guildId == 0) revert InvalidArgument();
    if (guildRegistry == address(0)) revert GuildRegistryNotSet();
    if (!IGuildMembershipRead(guildRegistry).isInGuild(guildId, msg.sender)) revert NotGuildMember();

    uint64 hourBucket = uint64(block.timestamp / 1 hours);
    uint16 used = _guildSubmittedByHour[guildId][hourBucket];
    if (used >= guildHourlyLimit) {
      uint256 retryAfter = (uint256(hourBucket) + 1) * 1 hours;
      revert RateLimitExceeded(guildHourlyLimit, used, retryAfter);
    }
    _guildSubmittedByHour[guildId][hourBucket] = used + 1;

    directiveId = _createDirective(
      DirectiveKind.Guild,
      guildId,
      proposerAgentTokenId,
      objective,
      agentsNeeded,
      x,
      z,
      hoursDuration
    );
  }

  function vote(uint256 directiveId, uint256 voterAgentTokenId, bool support) external {
    Directive storage d = _directives[directiveId];
    if (d.id == 0) revert DirectiveNotFound();

    _syncExpiry(d);
    if (d.status != DirectiveStatus.Open && d.status != DirectiveStatus.Active) {
      revert DirectiveNotVotable();
    }
    if (hasVoted[directiveId][msg.sender]) revert AlreadyVoted();

    hasVoted[directiveId][msg.sender] = true;
    voteChoice[directiveId][msg.sender] = support ? 1 : 2;

    if (support) {
      d.yesVotes += 1;
    } else {
      d.noVotes += 1;
    }

    emit DirectiveVoted(directiveId, msg.sender, voterAgentTokenId, support, d.yesVotes, d.noVotes);

    if (d.status == DirectiveStatus.Open && d.yesVotes >= d.agentsNeeded) {
      d.status = DirectiveStatus.Active;
      emit DirectiveActivated(directiveId, d.yesVotes, d.agentsNeeded);
    }
  }

  function markCompleted(uint256 directiveId) external {
    Directive storage d = _directives[directiveId];
    if (d.id == 0) revert DirectiveNotFound();
    _syncExpiry(d);
    if (msg.sender != owner && msg.sender != d.proposer) revert NotAuthorized();
    if (d.status != DirectiveStatus.Active) revert InvalidStatus();
    d.status = DirectiveStatus.Completed;
    emit DirectiveCompleted(directiveId);
  }

  function cancelDirective(uint256 directiveId) external {
    Directive storage d = _directives[directiveId];
    if (d.id == 0) revert DirectiveNotFound();
    _syncExpiry(d);
    if (msg.sender != owner && msg.sender != d.proposer) revert NotAuthorized();
    if (d.status != DirectiveStatus.Open && d.status != DirectiveStatus.Active) revert InvalidStatus();
    d.status = DirectiveStatus.Cancelled;
    emit DirectiveCancelled(directiveId);
  }

  function expireDirective(uint256 directiveId) external {
    Directive storage d = _directives[directiveId];
    if (d.id == 0) revert DirectiveNotFound();
    _syncExpiry(d);
  }

  function totalDirectives() external view returns (uint256) {
    return _directiveIds.length;
  }

  function directiveInfo(uint256 directiveId) external view returns (Directive memory directive) {
    directive = _directives[directiveId];
    if (directive.id == 0) revert DirectiveNotFound();
    directive.status = _deriveStatus(directive);
  }

  function getAllDirectiveData(
    uint256 offset,
    uint256 limit
  ) external view returns (Directive[] memory page, uint256 totalCount) {
    totalCount = _directiveIds.length;
    if (offset >= totalCount) {
      return (new Directive[](0), totalCount);
    }

    uint256 end = offset + limit;
    if (end > totalCount) end = totalCount;
    uint256 size = end - offset;
    page = new Directive[](size);

    for (uint256 i = 0; i < size; i++) {
      Directive memory d = _directives[_directiveIds[offset + i]];
      d.status = _deriveStatus(d);
      page[i] = d;
    }
  }

  function getDirectiveIds(
    uint256 offset,
    uint256 limit
  ) external view returns (uint256[] memory ids, uint256 totalCount) {
    totalCount = _directiveIds.length;
    if (offset >= totalCount) {
      return (new uint256[](0), totalCount);
    }

    uint256 end = offset + limit;
    if (end > totalCount) end = totalCount;
    uint256 size = end - offset;
    ids = new uint256[](size);

    for (uint256 i = 0; i < size; i++) {
      ids[i] = _directiveIds[offset + i];
    }
  }

  function getSubmitCounts(
    address account,
    uint256 guildId
  ) external view returns (uint16 soloToday, uint16 guildThisHour) {
    uint64 dayBucket = uint64(block.timestamp / 1 days);
    uint64 hourBucket = uint64(block.timestamp / 1 hours);
    soloToday = _soloSubmittedByDay[account][dayBucket];
    guildThisHour = _guildSubmittedByHour[guildId][hourBucket];
  }

  function _createDirective(
    DirectiveKind kind,
    uint256 guildId,
    uint256 proposerAgentTokenId,
    string calldata objective,
    uint16 agentsNeeded,
    int32 x,
    int32 z,
    uint32 hoursDuration
  ) internal returns (uint256 directiveId) {
    directiveId = nextDirectiveId++;
    uint64 createdAt = uint64(block.timestamp);
    uint64 expiresAt = uint64(block.timestamp + uint256(hoursDuration) * 1 hours);

    _directives[directiveId] = Directive({
      id: directiveId,
      kind: kind,
      guildId: guildId,
      proposer: msg.sender,
      proposerAgentTokenId: proposerAgentTokenId,
      objective: objective,
      agentsNeeded: agentsNeeded,
      x: x,
      z: z,
      createdAt: createdAt,
      expiresAt: expiresAt,
      status: DirectiveStatus.Open,
      yesVotes: 0,
      noVotes: 0
    });
    _directiveIds.push(directiveId);

    emit DirectiveSubmitted(
      directiveId,
      kind,
      guildId,
      msg.sender,
      proposerAgentTokenId,
      objective,
      agentsNeeded,
      x,
      z,
      expiresAt
    );
  }

  function _validateSubmitArgs(
    string calldata objective,
    uint16 agentsNeeded,
    uint32 hoursDuration
  ) internal view {
    if (bytes(objective).length == 0 || bytes(objective).length > maxObjectiveLength) {
      revert InvalidObjective();
    }
    if (agentsNeeded == 0) revert InvalidArgument();
    if (hoursDuration == 0 || hoursDuration > maxDurationHours) revert InvalidArgument();
  }

  function _deriveStatus(Directive memory d) internal view returns (DirectiveStatus) {
    if (
      (d.status == DirectiveStatus.Open || d.status == DirectiveStatus.Active) &&
      d.expiresAt <= block.timestamp
    ) {
      return DirectiveStatus.Expired;
    }
    return d.status;
  }

  function _syncExpiry(Directive storage d) internal {
    if (
      (d.status == DirectiveStatus.Open || d.status == DirectiveStatus.Active) &&
      d.expiresAt <= block.timestamp
    ) {
      d.status = DirectiveStatus.Expired;
      emit DirectiveExpired(d.id);
    }
  }
}
