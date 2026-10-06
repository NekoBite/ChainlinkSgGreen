// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Share of one SPV's revenue rights. Holders accrue USDC pro-rata and pull it with claim().
/// Classic "magnified dividend per share" accounting: no loops over holders.
contract SPVToken is ERC20 {
    uint256 private constant MAG = 2 ** 128;
    address public immutable hub;
    IERC20 public immutable usdc;
    uint256 public magnifiedPerShare;
    uint256 public totalDistributed;
    mapping(address => int256) private corrections;
    mapping(address => uint256) public withdrawn;

    event Distributed(uint256 amount);
    event Claimed(address indexed holder, uint256 amount);

    constructor(string memory n, string memory s, address _hub, IERC20 _usdc, address[] memory holders,
        uint256[] memory shares) ERC20(n, s)
    {
        hub = _hub;
        usdc = _usdc;
        for (uint256 i; i < holders.length; i++) _mint(holders[i], shares[i]);
    }

    /// Hub has already transferred `amount` USDC to this contract.
    function distribute(uint256 amount) external {
        require(msg.sender == hub, "only hub");
        require(totalSupply() > 0, "no supply");
        magnifiedPerShare += (amount * MAG) / totalSupply();
        totalDistributed += amount;
        emit Distributed(amount);
    }

    function accumulated(address a) public view returns (uint256) {
        return uint256(int256(magnifiedPerShare * balanceOf(a)) + corrections[a]) / MAG;
    }

    function claimable(address a) public view returns (uint256) {
        return accumulated(a) - withdrawn[a];
    }

    function claim() external {
        uint256 amt = claimable(msg.sender);
        require(amt > 0, "nothing");
        withdrawn[msg.sender] += amt;
        usdc.transfer(msg.sender, amt);
        emit Claimed(msg.sender, amt);
    }

    function _update(address from, address to, uint256 v) internal override {
        super._update(from, to, v);
        int256 c = int256(magnifiedPerShare * v);
        if (from != address(0)) corrections[from] += c;
        if (to != address(0)) corrections[to] -= c;
    }
}
