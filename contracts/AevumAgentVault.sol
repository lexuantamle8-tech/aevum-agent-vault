// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

/**
 * @title AevumAgentVault
 * @notice Policy-Bounded Agentic tUSD8 Payment Vault & ERC-8004 Escrow for QDay Aevum Testnet.
 * @dev Enforces least-privilege session policies (per-tx cap, rolling 24h cap, recipient allowlist,
 *      expiry, instant revocation, global emergency pause) to prevent runaway or prompt-injected
 *      autonomous AI agent spending.
 */
contract AevumAgentVault {
    // -------------------------------------------------------------------------
    // Custom Errors
    // -------------------------------------------------------------------------
    error NotOwner();
    error NotAgentOwner();
    error NotPrincipal();
    error NotSessionKey();
    error NotAuthorized();
    error VaultPaused();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidExpiry();
    error InvalidCaps();
    error AgentNotFound();
    error AgentInactive();
    error SessionNotFound();
    error SessionExpired();
    error SessionRevoked();
    error PerTxCapExceeded(uint256 requested, uint256 cap);
    error DailyCapExceeded(uint256 requested, uint256 remaining);
    error RecipientNotAllowed(address recipient);
    error InsufficientVaultBalance(uint256 requested, uint256 available);
    error EscrowNotFound();
    error EscrowNotActive();
    error EscrowDeadlineNotReached();
    error TransferFailed();
    error ReentrancyDetected();

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------
    struct AgentIdentity {
        address owner;
        string metadataUri;
        uint64 registeredAt;
        bool active;
    }

    struct SessionPolicy {
        uint256 agentId;
        address principal;
        address sessionKey;
        uint256 perTxCap;
        uint256 dailyCap;
        uint256 spentInWindow;
        uint64 windowStart;
        uint64 expiresAt;
        bool allowlistEnabled;
        bool revoked;
    }

    enum EscrowStatus {
        None,
        Active,
        Released,
        Refunded
    }

    struct Escrow {
        uint256 sessionId;
        uint256 agentId;
        address principal;
        address payee;
        uint256 amount;
        uint64 deadline;
        bytes32 milestoneHash;
        EscrowStatus status;
    }

    // -------------------------------------------------------------------------
    // Events (On-Chain Audit Trail)
    // -------------------------------------------------------------------------
    event AgentRegistered(
        uint256 indexed agentId,
        address indexed owner,
        string metadataUri,
        uint64 registeredAt
    );
    event AgentMetadataUpdated(uint256 indexed agentId, string metadataUri);
    event AgentDeactivated(uint256 indexed agentId);

    event VaultDeposited(address indexed principal, uint256 amount, uint256 newBalance);
    event VaultWithdrawn(address indexed principal, uint256 amount, uint256 newBalance);

    event SessionCreated(
        uint256 indexed sessionId,
        uint256 indexed agentId,
        address indexed principal,
        address sessionKey,
        uint256 perTxCap,
        uint256 dailyCap,
        uint64 expiresAt,
        bool allowlistEnabled
    );
    event RecipientAllowlistUpdated(
        uint256 indexed sessionId,
        address indexed recipient,
        bool allowed
    );
    event SessionRevokedEvent(uint256 indexed sessionId, address indexed revokedBy);

    event AgentPaymentSettled(
        uint256 indexed sessionId,
        uint256 indexed agentId,
        address indexed principal,
        address recipient,
        uint256 amount,
        bytes32 memoHash,
        uint256 timestamp
    );

    event EscrowCreated(
        uint256 indexed escrowId,
        uint256 indexed sessionId,
        uint256 indexed agentId,
        address principal,
        address payee,
        uint256 amount,
        uint64 deadline,
        bytes32 milestoneHash
    );
    event EscrowReleased(
        uint256 indexed escrowId,
        address indexed payee,
        uint256 amount,
        address releasedBy
    );
    event EscrowRefunded(
        uint256 indexed escrowId,
        address indexed principal,
        uint256 amount,
        address refundedBy
    );

    event PausedStatusChanged(bool paused);

    // -------------------------------------------------------------------------
    // State Variables
    // -------------------------------------------------------------------------
    address public immutable token;
    address public owner;
    bool public paused;

    uint256 private _locked = 1;

    uint256 public nextAgentId = 1;
    uint256 public nextSessionId = 1;
    uint256 public nextEscrowId = 1;

    mapping(uint256 => AgentIdentity) public agents;
    mapping(address => uint256) public balances;
    mapping(uint256 => SessionPolicy) public sessions;
    mapping(uint256 => mapping(address => bool)) public sessionRecipientAllowed;
    mapping(uint256 => Escrow) public escrows;

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert VaultPaused();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert ReentrancyDetected();
        _locked = 2;
        _;
        _locked = 1;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(address _token) {
        if (_token == address(0)) revert ZeroAddress();
        token = _token;
        owner = msg.sender;
    }

    // -------------------------------------------------------------------------
    // Emergency Controls
    // -------------------------------------------------------------------------
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedStatusChanged(_paused);
    }

    // -------------------------------------------------------------------------
    // ERC-8004-Aligned Agent Identity Registry
    // -------------------------------------------------------------------------
    function registerAgent(string calldata metadataUri) external returns (uint256 agentId) {
        agentId = nextAgentId++;
        uint64 nowTs = uint64(block.timestamp);
        agents[agentId] = AgentIdentity({
            owner: msg.sender,
            metadataUri: metadataUri,
            registeredAt: nowTs,
            active: true
        });
        emit AgentRegistered(agentId, msg.sender, metadataUri, nowTs);
    }

    function updateAgentMetadata(uint256 agentId, string calldata metadataUri) external {
        AgentIdentity storage ag = agents[agentId];
        if (ag.owner == address(0)) revert AgentNotFound();
        if (ag.owner != msg.sender) revert NotAgentOwner();
        ag.metadataUri = metadataUri;
        emit AgentMetadataUpdated(agentId, metadataUri);
    }

    function deactivateAgent(uint256 agentId) external {
        AgentIdentity storage ag = agents[agentId];
        if (ag.owner == address(0)) revert AgentNotFound();
        if (ag.owner != msg.sender && msg.sender != owner) revert NotAgentOwner();
        ag.active = false;
        emit AgentDeactivated(agentId);
    }

    // -------------------------------------------------------------------------
    // Principal Vault Accounting (tUSD8)
    // -------------------------------------------------------------------------
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        _safeTransferFrom(token, msg.sender, address(this), amount);
        uint256 newBal = balances[msg.sender] + amount;
        balances[msg.sender] = newBal;
        emit VaultDeposited(msg.sender, amount, newBal);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balances[msg.sender];
        if (bal < amount) revert InsufficientVaultBalance(amount, bal);
        uint256 newBal = bal - amount;
        balances[msg.sender] = newBal;
        _safeTransfer(token, msg.sender, amount);
        emit VaultWithdrawn(msg.sender, amount, newBal);
    }

    // -------------------------------------------------------------------------
    // Scoped Session Keys
    // -------------------------------------------------------------------------
    function createSession(
        uint256 agentId,
        address sessionKey,
        uint256 perTxCap,
        uint256 dailyCap,
        uint64 expiresAt,
        bool allowlistEnabled
    ) external whenNotPaused returns (uint256 sessionId) {
        AgentIdentity storage ag = agents[agentId];
        if (ag.owner == address(0)) revert AgentNotFound();
        if (!ag.active) revert AgentInactive();
        if (ag.owner != msg.sender) revert NotAgentOwner();
        if (sessionKey == address(0)) revert ZeroAddress();
        if (perTxCap == 0 || dailyCap < perTxCap) revert InvalidCaps();
        if (expiresAt <= block.timestamp) revert InvalidExpiry();

        sessionId = nextSessionId++;
        sessions[sessionId] = SessionPolicy({
            agentId: agentId,
            principal: msg.sender,
            sessionKey: sessionKey,
            perTxCap: perTxCap,
            dailyCap: dailyCap,
            spentInWindow: 0,
            windowStart: uint64(block.timestamp),
            expiresAt: expiresAt,
            allowlistEnabled: allowlistEnabled,
            revoked: false
        });

        emit SessionCreated(
            sessionId,
            agentId,
            msg.sender,
            sessionKey,
            perTxCap,
            dailyCap,
            expiresAt,
            allowlistEnabled
        );
    }

    function setRecipientAllowed(
        uint256 sessionId,
        address recipient,
        bool allowed
    ) external {
        SessionPolicy storage s = sessions[sessionId];
        if (s.principal == address(0)) revert SessionNotFound();
        if (s.principal != msg.sender) revert NotPrincipal();
        if (recipient == address(0)) revert ZeroAddress();
        sessionRecipientAllowed[sessionId][recipient] = allowed;
        emit RecipientAllowlistUpdated(sessionId, recipient, allowed);
    }

    function revokeSession(uint256 sessionId) external {
        SessionPolicy storage s = sessions[sessionId];
        if (s.principal == address(0)) revert SessionNotFound();
        if (s.principal != msg.sender && msg.sender != owner) revert NotAuthorized();
        s.revoked = true;
        emit SessionRevokedEvent(sessionId, msg.sender);
    }

    function getRemainingDailyAllowance(uint256 sessionId) external view returns (uint256) {
        SessionPolicy storage s = sessions[sessionId];
        if (s.principal == address(0) || s.revoked || block.timestamp > s.expiresAt) {
            return 0;
        }
        if (block.timestamp >= uint256(s.windowStart) + 1 days) {
            return s.dailyCap;
        }
        if (s.spentInWindow >= s.dailyCap) {
            return 0;
        }
        return s.dailyCap - s.spentInWindow;
    }

    // -------------------------------------------------------------------------
    // Policy-Enforced Agent Payments
    // -------------------------------------------------------------------------
    function executeAgentPayment(
        uint256 sessionId,
        address recipient,
        uint256 amount,
        bytes32 memoHash
    ) external nonReentrant whenNotPaused {
        SessionPolicy storage s = _enforceAndConsumePolicy(sessionId, recipient, amount);

        _safeTransfer(token, recipient, amount);

        emit AgentPaymentSettled(
            sessionId,
            s.agentId,
            s.principal,
            recipient,
            amount,
            memoHash,
            block.timestamp
        );
    }

    // -------------------------------------------------------------------------
    // Policy-Bounded Milestone Escrow
    // -------------------------------------------------------------------------
    function createEscrow(
        uint256 sessionId,
        address payee,
        uint256 amount,
        uint64 deadline,
        bytes32 milestoneHash
    ) external nonReentrant whenNotPaused returns (uint256 escrowId) {
        if (deadline <= block.timestamp) revert InvalidExpiry();
        SessionPolicy storage s = _enforceAndConsumePolicy(sessionId, payee, amount);

        escrowId = nextEscrowId++;
        escrows[escrowId] = Escrow({
            sessionId: sessionId,
            agentId: s.agentId,
            principal: s.principal,
            payee: payee,
            amount: amount,
            deadline: deadline,
            milestoneHash: milestoneHash,
            status: EscrowStatus.Active
        });

        emit EscrowCreated(
            escrowId,
            sessionId,
            s.agentId,
            s.principal,
            payee,
            amount,
            deadline,
            milestoneHash
        );
    }

    function releaseEscrow(uint256 escrowId) external nonReentrant whenNotPaused {
        Escrow storage e = escrows[escrowId];
        if (e.status == EscrowStatus.None) revert EscrowNotFound();
        if (e.status != EscrowStatus.Active) revert EscrowNotActive();

        SessionPolicy storage s = sessions[e.sessionId];
        bool isPrincipal = (msg.sender == e.principal);
        bool isActiveSessionKey = (
            msg.sender == s.sessionKey &&
            !s.revoked &&
            block.timestamp <= s.expiresAt
        );
        if (!isPrincipal && !isActiveSessionKey) revert NotAuthorized();

        e.status = EscrowStatus.Released;
        _safeTransfer(token, e.payee, e.amount);

        emit EscrowReleased(escrowId, e.payee, e.amount, msg.sender);
    }

    function refundEscrow(uint256 escrowId) external nonReentrant {
        Escrow storage e = escrows[escrowId];
        if (e.status == EscrowStatus.None) revert EscrowNotFound();
        if (e.status != EscrowStatus.Active) revert EscrowNotActive();

        SessionPolicy storage s = sessions[e.sessionId];
        if (msg.sender == e.principal) {
            // Principal can refund anytime on dispute or cancellation
        } else if (msg.sender == s.sessionKey) {
            if (block.timestamp <= e.deadline) revert EscrowDeadlineNotReached();
        } else {
            revert NotAuthorized();
        }

        e.status = EscrowStatus.Refunded;
        balances[e.principal] += e.amount;

        emit EscrowRefunded(escrowId, e.principal, e.amount, msg.sender);
    }

    // -------------------------------------------------------------------------
    // Internal Policy Enforcement & Safe ERC-20 Transfers
    // -------------------------------------------------------------------------
    function _enforceAndConsumePolicy(
        uint256 sessionId,
        address recipient,
        uint256 amount
    ) internal returns (SessionPolicy storage s) {
        s = sessions[sessionId];
        if (s.principal == address(0)) revert SessionNotFound();
        if (msg.sender != s.sessionKey) revert NotSessionKey();
        if (s.revoked) revert SessionRevoked();
        if (block.timestamp > s.expiresAt) revert SessionExpired();
        if (!agents[s.agentId].active) revert AgentInactive();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        if (s.allowlistEnabled && !sessionRecipientAllowed[sessionId][recipient]) {
            revert RecipientNotAllowed(recipient);
        }

        if (amount > s.perTxCap) {
            revert PerTxCapExceeded(amount, s.perTxCap);
        }

        if (block.timestamp >= uint256(s.windowStart) + 1 days) {
            s.windowStart = uint64(block.timestamp);
            s.spentInWindow = 0;
        }

        uint256 remaining = s.dailyCap - s.spentInWindow;
        if (amount > remaining) {
            revert DailyCapExceeded(amount, remaining);
        }

        uint256 bal = balances[s.principal];
        if (bal < amount) {
            revert InsufficientVaultBalance(amount, bal);
        }

        s.spentInWindow += amount;
        balances[s.principal] = bal - amount;
    }

    function _safeTransfer(address tokenAddr, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = tokenAddr.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }

    function _safeTransferFrom(
        address tokenAddr,
        address from,
        address to,
        uint256 amount
    ) internal {
        (bool ok, bytes memory data) = tokenAddr.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }
}
