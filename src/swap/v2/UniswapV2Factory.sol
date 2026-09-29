pragma solidity =0.5.16;

import './interfaces/IUniswapV2Factory.sol';
import './UniswapV2Pair.sol';

// Neuriio fork of Uniswap V2 (v2-core v1.0.1). Changes are marked "Neuriio": only the launchpad creates pairs (so
// nobody can open a graduating token's pool first at a bad price), and the factory holds the WHYPE and FeeVault
// addresses its pairs send their swap fee to (see UniswapV2Pair._takeFee).
contract UniswapV2Factory is IUniswapV2Factory {
    address public feeTo;
    address public feeToSetter;
    address public whype;     // Neuriio
    address public feeVault;  // Neuriio: set once
    address public launchpad; // Neuriio: set once

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint);

    constructor(address _feeToSetter, address _whype) public { // Neuriio: + _whype
        feeToSetter = _feeToSetter;
        whype = _whype; // Neuriio
    }

    function allPairsLength() external view returns (uint) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(msg.sender == launchpad, 'UniswapV2: FORBIDDEN'); // Neuriio
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

    // Neuriio: set once each
    function setFeeVault(address _feeVault) external {
        require(msg.sender == feeToSetter, 'UniswapV2: FORBIDDEN');
        require(feeVault == address(0) && _feeVault != address(0), 'UniswapV2: ALREADY_SET');
        feeVault = _feeVault;
    }

    // Neuriio
    function setLaunchpad(address _launchpad) external {
        require(msg.sender == feeToSetter, 'UniswapV2: FORBIDDEN');
        require(launchpad == address(0) && _launchpad != address(0), 'UniswapV2: ALREADY_SET');
        launchpad = _launchpad;
    }
}
