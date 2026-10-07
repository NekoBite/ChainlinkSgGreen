# Evidence

| What | Where |
|---|---|
| Full CRE CLI simulation, both epochs (fraud → rejected, honest → approved) | [`simulation-2026-10-07.log`](simulation-2026-10-07.log) |
| Broadcast run: rejection report written to Sepolia by the CRE simulator via the MockKeystoneForwarder | [tx 0x4b2b…1bf3](https://sepolia.etherscan.io/tx/0x4b2b3ce2d3533cc98ed13aecc5c020b9930a8144d0632feadf57fa3f9ccc1bf3) |
| GreenYieldHub (current deployment, Sepolia) | [0xa987…bB74](https://sepolia.etherscan.io/address/0xa987b3279C86aF07396209Be3197c57af70ebB74) |
| Dashboard during the fraud epoch (24-hour chart: red = "solar" claimed at night) | [`dashboard-fraud-epoch.png`](dashboard-fraud-epoch.png) |
| Contract tests (`forge test`) | 3/3 pass — fraud then honest, replay rejected, only-forwarder |

Reproduce: `DRY=1 ./run-demo.sh` (pure simulation, no gas) or `./run-demo.sh` (broadcast to Sepolia).
