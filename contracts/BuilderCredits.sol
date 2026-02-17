// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * BuilderCredits
 * - Onchain credit ledger for OpGrid builders.
 * - Registration grant: 1000 credits once.
 * - Daily claim: 500 base + 250 guild bonus (if in any guild).
 * - Action bonuses (guild invite / guild creation) with 24h cooldown per bonus type.
 * - Supports authorized spenders (e.g., game server relayer) to consume credits.
 */
interface IGuildMembershipReader {
  function isInAnyGuild(address account) external view returns (bool);
}

contract BuilderCredits {
  error NotOwner();
  error NotRegistrar();
  error NotSpender();
  error NotGuildEventSource();
  error InvalidAddress();
  error NotRegistered();
  error AlreadyRegistered();
  error CooldownActive(uint256 retryAt);
  error NoPendingBonus();
  error InsufficientCredits();

  enum BonusType {
    GuildInvite,
    GuildCreation
  }

  struct AccountState {
    bool registered;
    uint64 registeredAt;
    uint64 lastDailyClaimAt;
    uint256 credits;
  }

  address public owner;
  address public guildRegistry;
  address public guildEventSource;

  // Config (owner controlled)
  uint256 public initialRegistrationCredits = 1000;
  uint256 public baseDailyCredits = 500;
  uint256 public guildDailyBonusCredits = 250;
  uint256 public bonusClaimAmount = 250;
  uint256 public bonusCooldownSeconds = 1 days;
  uint256 public dailyClaimCooldownSeconds = 1 days;

  mapping(address => bool) public registrars;
  mapping(address => bool) public spenders;
  mapping(address => AccountState) private _accounts;
  mapping(address => uint64) public lastAnyBonusClaimAt;
  mapping(address => mapping(uint8 => uint64)) public lastBonusClaimAt;
  mapping(address => mapping(uint8 => uint32)) public pendingBonusClaims;

  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
  event GuildRegistryUpdated(address indexed guildRegistry);
  event GuildEventSourceUpdated(address indexed guildEventSource);
  event RegistrarUpdated(address indexed registrar, bool enabled);
  event SpenderUpdated(address indexed spender, bool enabled);
  event AccountRegistered(address indexed account, uint256 grantAmount, uint256 newBalance);
  event DailyCreditsClaimed(address indexed account, uint256 amount, bool guildMember, uint256 newBalance);
  event BonusQueued(address indexed account, BonusType bonusType, uint32 pendingCount);
  event BonusClaimed(address indexed account, BonusType bonusType, uint256 amount, uint256 newBalance);
  event CreditsConsumed(address indexed account, address indexed spender, uint256 amount, uint256 newBalance);
  event CreditsTransferred(address indexed from, address indexed to, uint256 amount);
  event CreditConfigUpdated(
    uint256 initialRegistrationCredits,
    uint256 baseDailyCredits,
    uint256 guildDailyBonusCredits,
    uint256 bonusClaimAmount,
    uint256 bonusCooldownSeconds,
    uint256 dailyClaimCooldownSeconds
  );

  constructor() {
    owner = msg.sender;
    registrars[msg.sender] = true;
    emit OwnershipTransferred(address(0), msg.sender);
    emit RegistrarUpdated(msg.sender, true);
  }

  modifier onlyOwner() {
    if (msg.sender != owner) revert NotOwner();
    _;
  }

  modifier onlyRegistrar() {
    if (!registrars[msg.sender]) revert NotRegistrar();
    _;
  }

  modifier onlySpender() {
    if (!spenders[msg.sender]) revert NotSpender();
    _;
  }

  modifier onlyGuildEventSource() {
    if (msg.sender != guildEventSource) revert NotGuildEventSource();
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

  function setGuildEventSource(address source) external onlyOwner {
    guildEventSource = source;
    emit GuildEventSourceUpdated(source);
  }

  function setRegistrar(address registrar, bool enabled) external onlyOwner {
    if (registrar == address(0)) revert InvalidAddress();
    registrars[registrar] = enabled;
    emit RegistrarUpdated(registrar, enabled);
  }

  function setSpender(address spender, bool enabled) external onlyOwner {
    if (spender == address(0)) revert InvalidAddress();
    spenders[spender] = enabled;
    emit SpenderUpdated(spender, enabled);
  }

  function setCreditConfig(
    uint256 initialRegistrationCredits_,
    uint256 baseDailyCredits_,
    uint256 guildDailyBonusCredits_,
    uint256 bonusClaimAmount_,
    uint256 bonusCooldownSeconds_,
    uint256 dailyClaimCooldownSeconds_
  ) external onlyOwner {
    initialRegistrationCredits = initialRegistrationCredits_;
    baseDailyCredits = baseDailyCredits_;
    guildDailyBonusCredits = guildDailyBonusCredits_;
    bonusClaimAmount = bonusClaimAmount_;
    bonusCooldownSeconds = bonusCooldownSeconds_;
    dailyClaimCooldownSeconds = dailyClaimCooldownSeconds_;

    emit CreditConfigUpdated(
      initialRegistrationCredits_,
      baseDailyCredits_,
      guildDailyBonusCredits_,
      bonusClaimAmount_,
      bonusCooldownSeconds_,
      dailyClaimCooldownSeconds_
    );
  }

  function registerAgent(address account) external onlyRegistrar {
    _register(account);
  }

  function selfRegister() external {
    _register(msg.sender);
  }

  function isRegistered(address account) external view returns (bool) {
    return _accounts[account].registered;
  }

  function creditBalance(address account) external view returns (uint256) {
    return _accounts[account].credits;
  }

  function accountState(
    address account
  )
    external
    view
    returns (
      bool registered,
      uint64 registeredAt,
      uint64 lastDailyClaimAt_,
      uint256 credits,
      uint32 pendingInviteBonuses,
      uint32 pendingCreationBonuses
    )
  {
    AccountState storage s = _accounts[account];
    return (
      s.registered,
      s.registeredAt,
      s.lastDailyClaimAt,
      s.credits,
      pendingBonusClaims[account][uint8(BonusType.GuildInvite)],
      pendingBonusClaims[account][uint8(BonusType.GuildCreation)]
    );
  }

  function claimDailyCredits() external returns (uint256 amount) {
    AccountState storage s = _accounts[msg.sender];
    if (!s.registered) revert NotRegistered();

    uint256 nextAllowed = uint256(s.lastDailyClaimAt) + dailyClaimCooldownSeconds;
    if (s.lastDailyClaimAt != 0 && block.timestamp < nextAllowed) {
      revert CooldownActive(nextAllowed);
    }

    bool guildMember = _isGuildMember(msg.sender);
    amount = baseDailyCredits + (guildMember ? guildDailyBonusCredits : 0);

    s.lastDailyClaimAt = uint64(block.timestamp);
    s.credits += amount;

    emit DailyCreditsClaimed(msg.sender, amount, guildMember, s.credits);
  }

  function claimBonus(BonusType bonusType) external returns (uint256 amount) {
    AccountState storage s = _accounts[msg.sender];
    if (!s.registered) revert NotRegistered();

    uint8 t = uint8(bonusType);
    if (pendingBonusClaims[msg.sender][t] == 0) revert NoPendingBonus();

    uint256 nextAllowed = uint256(lastAnyBonusClaimAt[msg.sender]) + bonusCooldownSeconds;
    if (lastAnyBonusClaimAt[msg.sender] != 0 && block.timestamp < nextAllowed) {
      revert CooldownActive(nextAllowed);
    }

    pendingBonusClaims[msg.sender][t] -= 1;
    lastAnyBonusClaimAt[msg.sender] = uint64(block.timestamp);
    lastBonusClaimAt[msg.sender][t] = uint64(block.timestamp);
    amount = bonusClaimAmount;
    s.credits += amount;

    emit BonusClaimed(msg.sender, bonusType, amount, s.credits);
  }

  function consumeCredits(address account, uint256 amount) external onlySpender {
    AccountState storage s = _accounts[account];
    if (!s.registered) revert NotRegistered();
    if (s.credits < amount) revert InsufficientCredits();

    s.credits -= amount;
    emit CreditsConsumed(account, msg.sender, amount, s.credits);
  }

  function transferCredits(address to, uint256 amount) external {
    if (to == address(0)) revert InvalidAddress();
    AccountState storage fromState = _accounts[msg.sender];
    if (!fromState.registered) revert NotRegistered();
    if (!_accounts[to].registered) revert NotRegistered();
    if (fromState.credits < amount) revert InsufficientCredits();

    fromState.credits -= amount;
    _accounts[to].credits += amount;
    emit CreditsTransferred(msg.sender, to, amount);
  }

  /**
   * Guild event hooks.
   * Call these from GuildRegistry for bonus eligibility.
   */
  function notifyGuildInvite(address inviter) external onlyGuildEventSource {
    _queueBonus(inviter, BonusType.GuildInvite);
  }

  function notifyGuildCreation(address creator) external onlyGuildEventSource {
    _queueBonus(creator, BonusType.GuildCreation);
  }

  function _register(address account) internal {
    if (account == address(0)) revert InvalidAddress();
    AccountState storage s = _accounts[account];
    if (s.registered) revert AlreadyRegistered();

    s.registered = true;
    s.registeredAt = uint64(block.timestamp);
    s.credits = initialRegistrationCredits;

    emit AccountRegistered(account, initialRegistrationCredits, s.credits);
  }

  function _queueBonus(address account, BonusType bonusType) internal {
    if (!_accounts[account].registered) {
      return;
    }
    uint8 t = uint8(bonusType);
    pendingBonusClaims[account][t] += 1;
    emit BonusQueued(account, bonusType, pendingBonusClaims[account][t]);
  }

  function _isGuildMember(address account) internal view returns (bool) {
    if (guildRegistry == address(0)) return false;
    return IGuildMembershipReader(guildRegistry).isInAnyGuild(account);
  }
}
