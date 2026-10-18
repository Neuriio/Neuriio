pragma solidity =0.5.16;

import './interfaces/IUniswapV2Factory.sol';
import './UniswapV2Pair.sol';

// Neuriio fork of Uniswap V2 (v2-core v1.0.1). Changes are marked "Neuriio": only a token's own NeuriioPad (per the
// NeuriioRegistry, any NeuriioPad version) creates its pair (so nobody can open a graduating token's pool first at a
// bad price), and the factory holds the quote token (USDC: every pool is TOKEN/USDC) and the NeuriioFees its pairs send
// their swap fee to (see UniswapV2Pair._takeFee). Part of the permanent core: every NeuriioPad version's pools live here.
interface INeuriioRegistry { // Neuriio
    function launchpadOf(address token) external view returns (address);
}

contract UniswapV2Factory is IUniswapV2Factory {
    address public feeTo;
    address public feeToSetter;
    address public quote;     // Neuriio: the token every pool is priced in (USDC)
    address public feeVault;  // Neuriio: owner-replaceable (0 = pools keep the fee, like V2)
    address public registry;  // Neuriio: set once (NeuriioRegistry)

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint);

    constructor(address _feeToSetter, address _quote) public { // Neuriio: + _quote
        feeToSetter = _feeToSetter;
        quote = _quote; // Neuriio
    }

    function allPairsLength() external view returns (uint) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        // Neuriio: TOKEN/quote only, created by that token's own NeuriioPad
        require(tokenA == quote || tokenB == quote, 'UniswapV2: FORBIDDEN');
        require(msg.sender == INeuriioRegistry(registry).launchpadOf(tokenA == quote ? tokenB : tokenA), 'UniswapV2: FORBIDDEN');
        require(tokenA != tokenB, 'UniswapV2: IDENTICAL_ADDRESSES');
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), 'UniswapV2: ZERO_ADDRESS');
        require(getPair[token0][token1] == address(0), 'UniswapV2: PAIR_EXISTS'); // single check is sufficient
        bytes memory bytecode = type(UniswapV2Pair).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        assembly {
            pair := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }
        IUniswapV2Pair(pair).initialize(token0, token1);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // populate mapping in the reverse direction
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address _feeTo) external {
        require(msg.sender == feeToSetter, 'UniswapV2: FORBIDDEN');
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, 'UniswapV2: FORBIDDEN');
        feeToSetter = _feeToSetter;
    }

    // Neuriio: every pool reads this on each swap, so a new NeuriioFees (a fix, a new fee split) takes over at once,
    // and address(0) is the emergency switch if a vault ever fails: swaps keep working and the fee stays in the pool.
    event FeeVaultSet(address feeVault);
    function setFeeVault(address _feeVault) external {
        require(msg.sender == feeToSetter, 'UniswapV2: FORBIDDEN');
        feeVault = _feeVault;
        emit FeeVaultSet(_feeVault);
    }

    // Neuriio
    function setRegistry(address _registry) external {
        require(msg.sender == feeToSetter, 'UniswapV2: FORBIDDEN');
        require(registry == address(0) && _registry != address(0), 'UniswapV2: ALREADY_SET');
        registry = _registry;
    }
}
