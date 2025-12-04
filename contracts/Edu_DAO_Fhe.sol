pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract EduDAOToolsFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchOpen;
    mapping(uint256 => uint256) public submissionsInBatch;
    mapping(uint256 => euint32) public encryptedBatchScoreSum;
    mapping(uint256 => euint32) public encryptedBatchSubmissionCount;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsChanged(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ToolSubmission(address indexed provider, uint256 indexed batchId, euint32 encryptedScore);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 scoreSum, uint256 submissionCount);

    error NotOwner();
    error NotProvider();
    error PausedError();
    error CooldownActive();
    error BatchClosedOrNonExistent();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidBatchId();
    error InvalidCooldown();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    modifier respectCooldown(address _address, mapping(address => uint256) storage _lastTime) {
        if (block.timestamp < _lastTime[_address] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        _initIfNeeded();
    }

    function _initIfNeeded() internal {
        if (!FHE.isInitialized()) {
            FHE.initialize();
        }
    }

    function _requireInitialized() internal view {
        if (!FHE.isInitialized()) {
            revert("FHE not initialized");
        }
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused != paused) {
            paused = _paused;
            if (_paused) {
                emit Paused(msg.sender);
            } else {
                emit Unpaused(msg.sender);
            }
        }
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidCooldown();
        emit CooldownSecondsChanged(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        isBatchOpen[currentBatchId] = true;
        submissionsInBatch[currentBatchId] = 0;
        encryptedBatchScoreSum[currentBatchId] = FHE.asEuint32(0);
        encryptedBatchSubmissionCount[currentBatchId] = FHE.asEuint32(0);
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        if (!isBatchOpen[batchId]) revert InvalidBatchId();
        isBatchOpen[batchId] = false;
        emit BatchClosed(batchId);
    }

    function submitToolScore(uint256 batchId, euint32 encryptedScore) external onlyProvider whenNotPaused respectCooldown(msg.sender, lastSubmissionTime) {
        if (!isBatchOpen[batchId]) revert BatchClosedOrNonExistent();

        encryptedBatchScoreSum[batchId] = encryptedBatchScoreSum[batchId].add(encryptedScore);
        encryptedBatchSubmissionCount[batchId] = encryptedBatchSubmissionCount[batchId].add(FHE.asEuint32(1));
        submissionsInBatch[batchId]++;
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit ToolSubmission(msg.sender, batchId, encryptedScore);
    }

    function requestBatchResultsDecryption(uint256 batchId) external onlyOwner whenNotPaused respectCooldown(msg.sender, lastDecryptionRequestTime) {
        if (submissionsInBatch[batchId] == 0) revert InvalidBatchId();

        euint32 memory sumCt = encryptedBatchScoreSum[batchId];
        euint32 memory countCt = encryptedBatchSubmissionCount[batchId];

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(sumCt);
        cts[1] = FHE.toBytes32(countCt);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        uint256 batchId = decryptionContexts[requestId].batchId;
        euint32 memory sumCt = encryptedBatchScoreSum[batchId];
        euint32 memory countCt = encryptedBatchSubmissionCount[batchId];

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(sumCt);
        cts[1] = FHE.toBytes32(countCt);

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint256 sum = abi.decode(cleartexts, (uint256));
        cleartexts = cleartexts[32:]; 
        uint256 count = abi.decode(cleartexts, (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, sum, count);
    }
}