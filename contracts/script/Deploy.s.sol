// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from "forge-std/Script.sol";
import {GreenYieldHub} from "../src/GreenYieldHub.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// Deploys everything and seeds one SPV with escrowed revenue.
/// FORWARDER defaults to the Sepolia MockKeystoneForwarder used by `cre workflow simulate`.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("CRE_ETH_PRIVATE_KEY");
        address me = vm.addr(pk);
        address fwd = vm.envOr("FORWARDER", address(0x15fC6ae953E024d975e77382eEeC56A9101f9F88));
        vm.startBroadcast(pk);
        MockUSDC usdc = new MockUSDC();
        GreenYieldHub hub = new GreenYieldHub(fwd, usdc);
        address[] memory h = new address[](3);
        h[0] = me; h[1] = address(0x1111111111111111111111111111111111111111); h[2] = address(0x2222222222222222222222222222222222222222);
        uint256[] memory s = new uint256[](3);
        s[0] = 500_000e18; s[1] = 300_000e18; s[2] = 200_000e18;
        // Lopburi, Thailand — real utility-scale solar region
        hub.registerSPV("Lopburi Solar + BESS SPV", me, 80, 200, 148000, 1006000, h, s);
        usdc.mint(me, 100_000e6);
        usdc.approve(address(hub), type(uint256).max);
        hub.escrowRevenue(0, 100_000e6);
        vm.stopBroadcast();
        console.log("USDC", address(usdc));
        console.log("HUB", address(hub));
        vm.writeFile("../.deployed", string.concat(vm.toString(address(hub)), "\n"));
    }
}
