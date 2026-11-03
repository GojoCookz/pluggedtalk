// Shared stable API codes and user-facing recovery copy. No runtime/server imports.
export const TRADING_ERRORS = Object.freeze({
  TRADING_INVALID:['Check the token, amount and settings, then review again.','Comprueba la moneda, el importe y los ajustes; después revisa otra vez.'],
  TRADING_NOT_FOUND:['Trade review not found. Request a new review.','No se encontró la revisión. Solicita una nueva.'],
  TRADING_UNVERIFIED:['This token is not a confirmed Plugged launch. Refresh the market.','Esta moneda no es un lanzamiento confirmado de Plugged. Actualiza el mercado.'],
  TRADING_DEPLOYMENT:['Contract verification changed. Trading is blocked until the operator re-verifies it.','La verificación del contrato cambió. Las operaciones están bloqueadas hasta que el operador lo verifique de nuevo.'],
  TRADING_STALE_RPC:['The RPC is stale or unavailable. Retry with a healthy connection.','El RPC está desactualizado o no disponible. Reintenta con una conexión operativa.'],
  TRADING_EXPIRED:['Review expired. Request a new quote before signing.','La revisión venció. Solicita otra cotización antes de firmar.'],
  TRADING_WALLET:['Wallet changed. Review again with the intended wallet.','La billetera cambió. Revisa otra vez con la billetera deseada.'],
  TRADING_INPUT_BALANCE:['Insufficient input balance. Add the input asset, then review again.','Saldo de entrada insuficiente. Añade la moneda de entrada y revisa otra vez.'],
  TRADING_ALLOWANCE:['Token approval changed. Review again to check the required approval.','La aprobación cambió. Revisa otra vez para comprobar la aprobación necesaria.'],
  TRADING_APPROVAL:['The token refused approval. Check its restrictions before retrying.','La moneda rechazó la aprobación. Comprueba sus restricciones antes de reintentar.'],
  TRADING_GAS:['Insufficient native ETH for estimated gas. Add ETH separately, then review again.','ETH nativo insuficiente para el gas estimado. Añade ETH por separado y revisa otra vez.'],
  TRADING_OUTPUT:['Minimum output is unavailable or too small. Review a different amount.','La salida mínima no está disponible o es demasiado pequeña. Revisa otro importe.'],
  TRADING_SUBMITTED:['A transaction is already attached. Check its confirmation or replacement.','Ya hay una transacción asociada. Comprueba su confirmación o reemplazo.'],
  TRADING_HASH:['Paste the complete transaction hash from your wallet.','Pega el hash completo de la transacción desde tu billetera.'],
  TRADING_MISMATCH:['The transaction does not match this review. Check the wallet and hash.','La transacción no coincide con esta revisión. Comprueba la billetera y el hash.'],
  TRADING_REPLACEMENT:['Replacement could not be verified. Use a wallet speed-up with the same trade, or a zero-value self-transfer cancellation with the same nonce.','No se pudo verificar el reemplazo. Usa una aceleración de la misma operación o una cancelación a tu propia dirección, sin valor y con el mismo nonce.'],
  TRADING_ORIGINAL_MINED:['The original transaction is already mined. Check its confirmation instead.','La transacción original ya está minada. Comprueba su confirmación.'],
  TRADING_CONFLICT:['This trade changed while it was being checked. Check its status again.','La operación cambió mientras se comprobaba. Comprueba su estado otra vez.'],
  TRADING_RPC:['Simulation or RPC request failed. Check liquidity, token restrictions and your wallet, then retry.','La simulación o la solicitud RPC falló. Comprueba la liquidez, las restricciones de la moneda y tu billetera; después reintenta.'],
});
export function tradingErrorCode(error){
  if(TRADING_ERRORS[error?.code])return error.code;
  const m=String(error?.shortMessage||error?.message||error||'');
  for(const [pattern,code] of [
    [/review not found|preparation not found/i,'TRADING_NOT_FOUND'],[/confirmed Plugged|Launch confirmation/i,'TRADING_UNVERIFIED'],
    [/bytecode|Engine code|Pool identity|Pool deployment|Launch pair/i,'TRADING_DEPLOYMENT'],[/RPC head|RPC must|unavailable.*RPC/i,'TRADING_STALE_RPC'],
    [/expired/i,'TRADING_EXPIRED'],[/Wallet changed/i,'TRADING_WALLET'],[/input balance|Fund the input/i,'TRADING_INPUT_BALANCE'],
    [/Allowance changed|Approval changed/i,'TRADING_ALLOWANCE'],[/refused approval/i,'TRADING_APPROVAL'],[/native ETH/i,'TRADING_GAS'],
    [/output is too small|Minimum output|TooLittleReceived/i,'TRADING_OUTPUT'],[/already submitted|different hash.*attached/i,'TRADING_SUBMITTED'],
    [/complete transaction hash/i,'TRADING_HASH'],[/differs|predates|Expected exactly one|not prepared/i,'TRADING_MISMATCH'],
    [/nonzero wallet|JSON object|Unsupported trading|positive decimal|supported exact-input|Choose buy|Slippage \(bps\)|Review validity/i,'TRADING_INVALID'],
  ])if(pattern.test(m))return code;
  return 'TRADING_RPC';
}
