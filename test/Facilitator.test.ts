import { expect } from "chai"
import { ethers } from "hardhat"
import { BigNumber, utils } from "ethers"

import { Contract } from "ethers"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address"

let vault: Contract,
  weth: Contract,
  aToken: Contract,
  pool: Contract,
  priceOracle: Contract,
  facilitator: Contract,
  gho: Contract,
  currentChainId: number,
  user1: SignerWithAddress,
  liquidator: SignerWithAddress

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
const USER_1_ADDRESS = "0x44Cc771fBE10DeA3836f37918cF89368589b6316"
const AAVE_V3_POOL_ADDRESS = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"

const waitForTx = async (_tx) => (await _tx).wait(1)

/**
 * NOTE: In order to run tests, you must disable the proof verification within the contract
 */
describe("Facilitator", () => {
  beforeEach(async () => {
    currentChainId = (await ethers.provider.getNetwork()).chainId

    const Vault = await ethers.getContractFactory("Vault")
    const Facilitator = await ethers.getContractFactory("Facilitator")
    const Token = await ethers.getContractFactory("Token")
    const MockGho = await ethers.getContractFactory("MockGho")
    const PriceOracle = await ethers.getContractFactory("PriceOracle")

    const BorrowLogic = await ethers.getContractFactory("BorrowLogic")
    const BridgeLogic = await ethers.getContractFactory("BridgeLogic")
    const EModeLogic = await ethers.getContractFactory("EModeLogic")
    const LiquidationLogic = await ethers.getContractFactory("LiquidationLogic")
    const PoolLogic = await ethers.getContractFactory("PoolLogic")
    const SupplyLogic = await ethers.getContractFactory("SupplyLogic")

    const borrowLogic = await BorrowLogic.deploy()
    const bridgeLogic = await BridgeLogic.deploy()
    const eModeLogic = await EModeLogic.deploy()
    const FlashLoanLogic = await ethers.getContractFactory("FlashLoanLogic", {
      libraries: { BorrowLogic: borrowLogic.address },
    })
    const flashLoanLogic = await FlashLoanLogic.deploy()
    const liquidationLogic = await LiquidationLogic.deploy()
    const poolLogic = await PoolLogic.deploy()
    const supplyLogic = await SupplyLogic.deploy()

    const Pool = await ethers.getContractFactory("Pool", {
      libraries: {
        BorrowLogic: borrowLogic.address,
        BridgeLogic: bridgeLogic.address,
        EModeLogic: eModeLogic.address,
        FlashLoanLogic: flashLoanLogic.address,
        LiquidationLogic: liquidationLogic.address,
        PoolLogic: poolLogic.address,
        SupplyLogic: supplyLogic.address,
      },
    })

    const signers = await ethers.getSigners()
    const fakeGiriGiriBashi = signers[0]
    liquidator = signers[1]

    pool = await Pool.attach(AAVE_V3_POOL_ADDRESS)
    gho = await MockGho.deploy()
    priceOracle = await PriceOracle.deploy()
    vault = await Vault.deploy(priceOracle.address, gho.address, fakeGiriGiriBashi.address, currentChainId, 0)
    user1 = await ethers.getImpersonatedSigner(USER_1_ADDRESS)
    weth = await Token.attach(WETH)
    facilitator = await Facilitator.deploy(fakeGiriGiriBashi.address, gho.address, currentChainId, 0)

    await vault.setAccount(facilitator.address)
    await facilitator.setAccount(vault.address)

    const { aTokenAddress } = await pool.getReserveData(weth.address)
    const AToken = await ethers.getContractFactory("AToken")
    aToken = await AToken.attach(aTokenAddress)

    await priceOracle.setAssetPrice(aToken.address, "250000000000") // eth = 2500$
    await priceOracle.setAssetPrice(gho.address, "100000000") // gho = 1$
  })

  it("should be able to mint gho after having deposited the collateral into the vault", async () => {
    const amount = utils.parseEther("100")
    await weth.connect(user1).approve(pool.address, amount)
    await pool.connect(user1).supply(weth.address, amount, user1.address, 0),
      await aToken.connect(user1).approve(vault.address, amount)
    const { events: mintEvents } = await waitForTx(vault.connect(user1).mint(aToken.address, user1.address, amount))
    const {
      args: { amount: ghoAmount },
    } = mintEvents.find(({ event }) => event === "AuthorizedMint")
    await facilitator.verifyProofAndMint(user1.address, ghoAmount)

    const ghoAmountToBurn = ghoAmount //utils.parseEther("250000")
    await gho.connect(user1).approve(facilitator.address, ghoAmountToBurn)
    await facilitator.connect(user1).burnAndReleaseCollateral(aToken.address, user1.address, ghoAmountToBurn)
    await expect(
      vault.connect(user1).verifyBurnAndReleaseCollateral(aToken.address, user1.address, ghoAmountToBurn),
    ).to.emit(vault, "CollateralReleased")
  })

  it("should be able to liquidate ALL the collateral if the price drops a lot", async () => {
    const amount = utils.parseEther("100")
    await weth.connect(user1).approve(pool.address, amount)
    await pool.connect(user1).supply(weth.address, amount, user1.address, 0),
      await aToken.connect(user1).approve(vault.address, amount)
    const { events: mintEvents } = await waitForTx(vault.connect(user1).mint(aToken.address, user1.address, amount))
    const {
      args: { amount: ghoAmount },
    } = mintEvents.find(({ event }) => event === "AuthorizedMint")
    await facilitator.verifyProofAndMint(user1.address, ghoAmount)
    // ETH price -> 2500$, collateral = 100ETH (250k$) -> debt = 85% * 250k$ = 212500$

    await priceOracle.setAssetPrice(aToken.address, "10000000000")
    // ETH price -> 1000$, collateral = 100ETH (100k$) -> debt = 212500 > 210000 -> LIQUIDABLE

    const amountToLiquidate = utils.parseUnits("212500")
    const amountLiquidatedCollateral = amount
    await expect(
      vault
        .connect(user1)
        .verifiyInitLiquidationAndLiquidate(aToken.address, user1.address, liquidator.address, amountToLiquidate),
    )
      .to.emit(vault, "Liquidated")
      .withArgs(aToken.address, user1.address, liquidator.address, amountLiquidatedCollateral)
  })

  it("should be able to liquidate PART of the collateral if the price drops a lot", async () => {
    const amount = utils.parseEther("100")
    await weth.connect(user1).approve(pool.address, amount)
    await pool.connect(user1).supply(weth.address, amount, user1.address, 0),
      await aToken.connect(user1).approve(vault.address, amount)
    const { events: mintEvents } = await waitForTx(vault.connect(user1).mint(aToken.address, user1.address, amount))
    const {
      args: { amount: ghoAmount },
    } = mintEvents.find(({ event }) => event === "AuthorizedMint")
    await facilitator.verifyProofAndMint(user1.address, ghoAmount)
    // ETH price -> 2500$, collateral = 100ETH (250k$) -> debt = 85% * 250k$ = 212500$

    await priceOracle.setAssetPrice(aToken.address, "210000000000")
    // ETH price -> 2100$, collateral = 100ETH (210k$) -> debt = 212500 > 210000 -> LIQUIDABLE

    const ethPrice = BigNumber.from("210000000000")
    const ghoPrice = BigNumber.from("100000000")
    const amountToLiquidate = utils.parseUnits("5000")
    const baseCollateral = amountToLiquidate.mul(ghoPrice).div(ethPrice)
    const amountLiquidatedCollateral = baseCollateral.add(baseCollateral.mul("500").div("10000"))

    await expect(
      vault
        .connect(user1)
        .verifiyInitLiquidationAndLiquidate(aToken.address, user1.address, liquidator.address, amountToLiquidate),
    )
      .to.emit(vault, "Liquidated")
      .withArgs(aToken.address, user1.address, liquidator.address, amountLiquidatedCollateral)
  })
})
