// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReceiverTemplate} from "./keystone/ReceiverTemplate.sol";
import {SPVToken} from "./SPVToken.sol";

/// SPV registry + revenue escrow + Chainlink CRE report receiver.
/// The operator escrows revenue; CRE verifies each epoch and either releases it
/// to token holders or writes an auditable zero-revenue rejection.
contract GreenYieldHub is ReceiverTemplate {
    struct SPV {
        string name;
        address operator;
        SPVToken token;
        uint32 solarMWp;      // nameplate solar capacity
        uint32 batteryMWh;    // battery energy capacity
        int32 latE4;          // latitude  × 1e4
        int32 lonE4;          // longitude × 1e4
        uint256 escrow;       // USDC (6dp) waiting for verification
        uint256 totalPaid;
    }

    struct Epoch {
        uint256 spvId;
        uint64 epochId;
        bool approved;
        uint8 aiScore;        // 0-100 from the LLM pattern layer
        uint16 violations;    // bitmask of failed physics rules
        uint256 claimedUsdc;  // what the operator claimed
        uint256 paidUsdc;     // what actually went to holders
        bytes32 evidenceHash; // keccak of the off-chain evidence JSON
        uint64 timestamp;
    }

    /// 24/7 granular certificate for one epoch: which local hours were covered by clean energy,
    /// where (the SPV's grid region + coordinates) and when (periodStart = local midnight, unix).
    struct Certificate {
        uint64 periodStart;
        uint32 cleanHourMask;  // bit h set = hour h (local time) fully matched by clean energy
        uint16 cfeBps;         // 24/7 carbon-free-energy score in basis points (10000 = 100%)
        uint32 greenMWhX10;    // hourly-matched clean MWh × 10
    }

    /// Report payload written by the CRE workflow (abi-encoded, no selector).
    struct Report {
        uint256 spvId;
        uint64 epochId;
        bool approved;
        uint8 aiScore;
        uint16 violations;
        uint256 claimedUsdc;
        bytes32 evidenceHash;
        uint64 periodStart;
        uint32 cleanHourMask;
        uint16 cfeBps;
        uint32 greenMWhX10;
    }

    IERC20 public immutable usdc;
    SPV[] internal spvs;
    Epoch[] public epochs;
    Certificate[] public certificates;              // same index as `epochs`
    mapping(uint256 => string) public gridRegion;   // e.g. "TH-EGAT-Central"
    mapping(uint256 => mapping(uint64 => bool)) public processed;

    event SPVRegistered(uint256 indexed spvId, string name, address token);
    event RevenueEscrowed(uint256 indexed spvId, uint256 amount);
    event EpochSettled(uint256 indexed spvId, uint64 indexed epochId, bool approved, uint8 aiScore,
                       uint16 violations, uint256 claimedUsdc, uint256 paidUsdc, bytes32 evidenceHash);
    event CertificateIssued(uint256 indexed spvId, uint64 indexed epochId, string gridRegion, uint64 periodStart,
        uint32 cleanHourMask, uint16 cfeBps, uint32 greenMWhX10);

    constructor(address forwarder, IERC20 _usdc) ReceiverTemplate(forwarder) { usdc = _usdc; }

    /// The SPVToken is deployed separately (with this hub as its `hub`) — embedding its creation
    /// code here would push the hub's deployment past the per-transaction gas cap.
    function registerSPV(string calldata name, address operator, SPVToken t, uint32 solarMWp, uint32 batteryMWh,
        int32 latE4, int32 lonE4) external onlyOwner returns (uint256 id)
    {
        require(t.hub() == address(this), "token hub");
        id = spvs.length;
        spvs.push(SPV(name, operator, t, solarMWp, batteryMWh, latE4, lonE4, 0, 0));
        emit SPVRegistered(id, name, address(t));
    }

    function setGridRegion(uint256 spvId, string calldata region) external onlyOwner { gridRegion[spvId] = region; }

    function escrowRevenue(uint256 spvId, uint256 amount) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        spvs[spvId].escrow += amount;
        emit RevenueEscrowed(spvId, amount);
    }

    // ---- views for the workflow and dashboard ----
    function spvCount() external view returns (uint256) { return spvs.length; }
    function epochCount() external view returns (uint256) { return epochs.length; }
    function getSPV(uint256 id) external view returns (string memory name, address token, uint32 solarMWp,
        uint32 batteryMWh, int32 latE4, int32 lonE4, uint256 escrow, uint256 totalPaid)
    {
        SPV storage s = spvs[id];
        return (s.name, address(s.token), s.solarMWp, s.batteryMWh, s.latE4, s.lonE4, s.escrow, s.totalPaid);
    }

    // ---- CRE entry point (called by ReceiverTemplate.onReport after forwarder check) ----
    function _processReport(bytes calldata raw) internal override {
        Report memory r = abi.decode(raw, (Report));
        require(!processed[r.spvId][r.epochId], "epoch done");
        processed[r.spvId][r.epochId] = true;

        SPV storage s = spvs[r.spvId];
        uint256 paid;
        if (r.approved && r.violations == 0) {
            paid = r.claimedUsdc < s.escrow ? r.claimedUsdc : s.escrow;
            if (paid > 0) {
                s.escrow -= paid;
                s.totalPaid += paid;
                usdc.transfer(address(s.token), paid);
                s.token.distribute(paid);
            }
        }
        epochs.push(Epoch(r.spvId, r.epochId, r.approved, r.aiScore, r.violations, r.claimedUsdc, paid,
                          r.evidenceHash, uint64(block.timestamp)));
        // A rejected epoch earns no certificate: zero clean hours on record.
        Certificate memory c = r.approved && r.violations == 0
            ? Certificate(r.periodStart, r.cleanHourMask, r.cfeBps, r.greenMWhX10)
            : Certificate(r.periodStart, 0, 0, 0);
        certificates.push(c);
        emit EpochSettled(r.spvId, r.epochId, r.approved, r.aiScore, r.violations, r.claimedUsdc, paid, r.evidenceHash);
        emit CertificateIssued(r.spvId, r.epochId, gridRegion[r.spvId], c.periodStart, c.cleanHourMask, c.cfeBps,
            c.greenMWhX10);
    }
}
