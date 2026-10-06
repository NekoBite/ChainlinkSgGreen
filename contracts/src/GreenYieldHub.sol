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

    IERC20 public immutable usdc;
    SPV[] internal spvs;
    Epoch[] public epochs;
    mapping(uint256 => mapping(uint64 => bool)) public processed;

    event SPVRegistered(uint256 indexed spvId, string name, address token);
    event RevenueEscrowed(uint256 indexed spvId, uint256 amount);
    event EpochSettled(uint256 indexed spvId, uint64 indexed epochId, bool approved, uint8 aiScore,
                       uint16 violations, uint256 claimedUsdc, uint256 paidUsdc, bytes32 evidenceHash);

    constructor(address forwarder, IERC20 _usdc) ReceiverTemplate(forwarder) { usdc = _usdc; }

    function registerSPV(string calldata name, address operator, uint32 solarMWp, uint32 batteryMWh,
        int32 latE4, int32 lonE4, address[] calldata holders, uint256[] calldata shares)
        external onlyOwner returns (uint256 id)
    {
        SPVToken t = new SPVToken(name, "SPV", usdc, holders, shares);
        id = spvs.length;
        spvs.push(SPV(name, operator, t, solarMWp, batteryMWh, latE4, lonE4, 0, 0));
        emit SPVRegistered(id, name, address(t));
    }

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
    function _processReport(bytes calldata report) internal override {
        (uint256 spvId, uint64 epochId, bool approved, uint8 aiScore, uint16 violations,
         uint256 claimedUsdc, bytes32 evidenceHash) =
            abi.decode(report, (uint256, uint64, bool, uint8, uint16, uint256, bytes32));
        require(!processed[spvId][epochId], "epoch done");
        processed[spvId][epochId] = true;

        SPV storage s = spvs[spvId];
        uint256 paid;
        if (approved && violations == 0) {
            paid = claimedUsdc < s.escrow ? claimedUsdc : s.escrow;
            if (paid > 0) {
                s.escrow -= paid;
                s.totalPaid += paid;
                usdc.transfer(address(s.token), paid);
                s.token.distribute(paid);
            }
        }
        epochs.push(Epoch(spvId, epochId, approved, aiScore, violations, claimedUsdc, paid, evidenceHash,
                          uint64(block.timestamp)));
        emit EpochSettled(spvId, epochId, approved, aiScore, violations, claimedUsdc, paid, evidenceHash);
    }
}
