// Detecta el correo de CONFIRMACIÓN de cambio de correo que el banco manda cuando el
// cliente completa el cambio (pegó el OTP y guardó). Sirve para cerrar el onboarding
// automáticamente, sin que el cliente tenga que marcar un checkbox manual.
//
// Patrones reales (capturados en producción):
//   Nequi:        from somos@nequi.com.co | "¡Correo cambiado exitosamente!" / "ha sido cambiado con éxito"
//   Bancolombia:  asunto "Alertas y Notificaciones" | "Actualizaste tu informacion personal" / "¿Fuiste tú?"

// Frases que SOLO aparecen en el correo de "cambio COMPLETADO con éxito".
const CONFIRM_PATTERNS = [
  // Nequi — confirmación exitosa
  /correo\s+cambiad[oa]\s+exitosamente/i,
  /ha\s+sido\s+cambiad[oa]\s+con\s+éxito/i,
  /correo\s+en\s+nequi\s+exitoso/i,
  // Bancolombia — confirmación de actualización
  /actualizaste\s+tu\s+informaci[oó]n\s+personal/i,
];

// Señales de que es un OTP (no una confirmación). Si aparecen, NO es confirmación.
// CRÍTICO: Nequi manda el OTP TAMBIÉN desde somos@nequi.com.co con asunto "Código confirmar
// el correo de tu Nequi" — por eso NO se puede usar el remitente como señal de confirmación.
const OTP_HINTS = /(c[oó]digo|verificaci[oó]n|token)/i;

/**
 * ¿Es el correo de confirmación de que el cambio YA se completó? Distinto del OTP y del pago.
 * Solo true si el contenido tiene una frase de "éxito" Y NO parece un correo de código.
 */
export function isChangeConfirmation({ subject = '', text = '', html = '' }) {
  const body = `${subject}\n${text || stripTags(html)}`;
  const matchesConfirm = CONFIRM_PATTERNS.some((re) => re.test(body));
  if (!matchesConfirm) return false;
  // El de Nequi exitoso dice "cambiado con éxito" y NO trae "código" → pasa.
  // El OTP dice "Código confirmar..." → si la única señal fuera el asunto con "código", lo
  // excluimos salvo que también tenga una frase de éxito clara (lo cual no pasa en el OTP).
  if (OTP_HINTS.test(subject) && !/exitoso|exitosamente|con éxito|actualizaste/i.test(body)) {
    return false;
  }
  return true;
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
}
