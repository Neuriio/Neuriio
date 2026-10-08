pragma solidity >=0.5.0;

// Neuriio: not part of Uniswap V2. What the pair needs to route its swap fee to the NeuriioFees.

interface INeuriioFactory {
    function whype() external view returns (address);
    function feeVault() external view returns (address);
}

interface INeuriioFeeVault {
    function notifyPoolFee(address token) external;
}
