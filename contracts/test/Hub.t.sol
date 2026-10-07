// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {GreenYieldHub} from "../src/GreenYieldHub.sol";
import {SPVToken} from "../src/SPVToken.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract HubTest is Test {
    GreenYieldHub hub; MockUSDC usdc; address fwd = address(0xF0);
    address a = address(0xA); address b = address(0xB);

    function setUp() public {
        usdc = new MockUSDC();
        hub = new GreenYieldHub(fwd, usdc);
        address[] memory h = new address[](2); h[0] = a; h[1] = b;
        uint256[] memory s = new uint256[](2); s[0] = 600e18; s[1] = 400e18;
        SPVToken token = new SPVToken("Lopburi Solar+BESS", "SPV", address(hub), usdc, h, s);
        hub.registerSPV("Lopburi Solar+BESS", address(this), token, 80, 200, 148000, 1006000);
        usdc.mint(address(this), 50_000e6); usdc.approve(address(hub), type(uint256).max);
        hub.escrowRevenue(0, 50_000e6);
    }

    function _report(uint64 ep, bool ok, uint16 v, uint256 amt) internal {
        vm.prank(fwd);
        hub.onReport("", abi.encode(GreenYieldHub.Report(0, ep, ok, uint8(ok ? 88 : 12), v, amt, bytes32(0), 1_791_000_000, 0xFC0FC0, 6667, 2400)));
    }

    function test_fraudThenHonest() public {
        _report(1, false, 0x1F, 40_000e6);
        (,,,,,, uint256 esc,) = hub.getSPV(0);
        assertEq(esc, 50_000e6);           // nothing moved
        assertEq(hub.epochCount(), 1);     // but the rejection is on record
        (, uint32 mask0, uint16 cfe0,) = hub.certificates(0);
        assertEq(mask0, 0); assertEq(cfe0, 0); // and it earns no clean-energy certificate

        _report(2, true, 0, 17_822e6);
        (, address tok,,,,,,) = hub.getSPV(0);
        assertApproxEqAbs(SPVToken(tok).claimable(a), 10_693_200_000, 2);  // 60%
        (uint64 start, uint32 mask, uint16 cfe, uint32 green) = hub.certificates(1);
        assertEq(start, 1_791_000_000); assertEq(mask, 0xFC0FC0); assertEq(cfe, 6667); assertEq(green, 2400);
        vm.prank(b); SPVToken(tok).claim();
        assertApproxEqAbs(usdc.balanceOf(b), 7_128_800_000, 2);            // 40%
    }

    function test_replayRejected() public {
        _report(2, true, 0, 1e6);
        vm.expectRevert(bytes("epoch done"));
        _report(2, true, 0, 1e6);
    }

    function test_onlyForwarder() public {
        vm.expectRevert();
        hub.onReport("", abi.encode(GreenYieldHub.Report(0, 9, true, 90, 0, 1, bytes32(0), 0, 0, 0, 0)));
    }
}
