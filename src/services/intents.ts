import { normalize } from '../utils/text';

/**
 * ÚNICA fuente de las reglas de intención del chat (chat clásico y chat en vivo usan las mismas).
 *
 * Todas se evalúan sobre el texto normalizado (minúsculas, sin tildes ni signos) y en este orden de prioridad:
 *   1. identity  → "¿quién eres?", "¿eres un bot / una persona?"           (se responde, nunca escala)
 *   2. thanks    → "gracias", "ok", "chao"                                 (se responde, nunca escala)
 *   3. human     → pide hablar con un asesor o una persona                  (reúne datos y pasa a la cola)
 *   4. sensitive → SU pago, SU deuda, SU proceso jurídico (asunto personal)  (reúne datos y pasa a la cola)
 *   5. greeting  → "hola", "buenas tardes"                                 (saludo corto)
 *   6. help      → "necesito ayuda", "tengo una pregunta"                  (pregunta qué necesita)
 *   7. other     → cualquier otra cosa: la responde el modelo con el contenido del sitio
 *
 * Preguntar POR un servicio ("¿qué es la asesoría legal?", "¿tienen abogados?") no es un asunto personal: lo
 * responde el bot con el sitio. Solo es sensible cuando el visitante habla de su propio caso.
 */
export type Intent = 'identity' | 'thanks' | 'human' | 'sensitive' | 'greeting' | 'help' | 'other';

export const IDENTITY_RE =
  /\b(que|quien) (eres|sos|es este chat)\b|\bquien eres tu\b|\beres (un |una )?(bot|robot|ia|inteligencia artificial|humano|persona|asistente|real|maquina)\b|\bcomo te llamas\b|\bcon quien (hablo|estoy hablando)\b|\bque haces\b|\bhablo con (un |una )?(bot|robot|maquina|persona)\b/;
export const THANKS_RE =
  /^(muchas |mil )?gracias\b|^(listo |bueno )?(ok|okey|okay|vale|perfecto|excelente|genial|entendido|de acuerdo)\b.{0,15}$|^(adios|chao|hasta luego|nos vemos|bye)\b/;
/** "persona" suelta (p. ej. "persona natural") no es pedir un asesor; "hablar con una persona" sí. */
export const HUMAN_RE =
  /\b(asesor|asesora|asesores|agente|operador|operadora|humano|persona real|atencion humana|hablar con (alguien|una persona|un humano|un representante|un agente|un funcionario)|quiero (una |un )?(persona|humano)|comunicarme con (alguien|una persona)|que me (llamen|llame|contacten|contacte))\b/;
/** Siempre es un asunto personal del visitante. */
const PERSONAL_RE =
  /\b(paz y salvo|acuerdos? de pago|cuanto debo|lo que debo|mi deuda|mis deudas|mi saldo|mi credito|mis creditos|mi obligacion|mis obligaciones|mi cuenta|mi caso|mi proceso|mi pago|mis pagos|mi cobro|me (estan )?(cobrando|llamando)|me cobran|me llaman|me llamaron|me (llego|llegaron)|me demandaron|me embargaron|estoy reportad[oa]|me reportaron|datacredito|centrales de riesgo|refinanciar|refinanciacion|abonar|quiero pagar|necesito pagar|puedo pagar|como pago|donde pago|link de pago|medios de pago|formas de pago|pagar (mi|la|el|lo))\b/;
/** Temas que solo son personales si el visitante habla de sí mismo ("tengo una deuda", "necesito un abogado"). */
const TOPIC_RE =
  /\b(pago|pagos|pagar|abono|deuda|deudas|saldo|saldos|acuerdo|acuerdos|negociar|negociacion|juridic[oa]s?|demanda|demandas|embargo|embargos|abogado|abogados|legal|legales|cobro|cobros|credito|creditos|obligacion|obligaciones)\b/;
const SELF_RE = /\b(mi|mis|me|tengo|tenia|debo|debia|quiero|quisiera|necesito|requiero|estoy)\b/;
/** Pedir información de la empresa o de un servicio: no es un asunto personal aunque nombre el tema. */
const INFO_RE = /\b(informacion|info|que es|que son|en que consiste|como funciona|ofrecen|ofrece|servicio|servicios|que hacen|saber (mas|sobre|de))\b/;
/** `n` ya normalizado. */
export const isSensitive = (n: string): boolean => PERSONAL_RE.test(n) || (TOPIC_RE.test(n) && SELF_RE.test(n) && !INFO_RE.test(n));
export const GREETING_RE = /^(hola|holi|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hey|saludos)\b/;
const HELP_RE =
  /^(necesito|quiero|requiero|busco)( una| un poco de)? (ayuda|informacion)\b.{0,15}$|^(ayuda|ayudame|ayudenme)\b.{0,12}$|^(me (puedes|puede|pueden|podrias|podria) ayudar|tengo una (duda|pregunta|consulta|inquietud)|una (pregunta|consulta))\b.{0,10}$/;

/** Respuesta afirmativa a "¿quieres que te comunique con un asesor?". */
export const AFFIRM_RE =
  /^(si|sii+|claro|dale|ok|okey|okay|vale|bueno|de acuerdo|por favor|porfa|porfavor|listo|perfecto|me parece|por supuesto|hagale|afirmativo|quiero|lo quiero|me gustaria|seria bueno|esta bien)\b/;
/** Respuesta negativa a esa misma oferta. */
export const DENY_RE = /^(no|nop|nope|ahora no|despues|luego|mas tarde|todavia no|aun no|tal vez despues|no por ahora|no es necesario|no hace falta)\b/;
/** Ya no quiere pasar con un asesor mientras el bot le pide los datos. */
export const CANCEL_RE =
  /\b(ya no|olvidalo|olvidelo|olvida eso|cancela|cancelar|mejor no|no necesito (un |una )?(asesor|asesora|ayuda)|no quiero (hablar con )?(un |una )?(asesor|asesora|persona)|ya lo resolvi|ya no es necesario)\b/;
/** No quiere o no puede dar sus datos: se le pasa igual con el asesor. */
export const REFUSE_RE =
  /\b(no (quiero|deseo) dar|prefiero no|no (te |le )?(voy a|puedo) dar|no (la|lo) tengo|no me (la|lo) se|no (lo |la )?recuerdo|no se cual|no tengo (el |la |mi )?(numero|documento|cedula|cartera))\b/;
/** Pregunta por la espera cuando ya está en la cola de un asesor. */
export const WAIT_RE =
  /\b(cuanto (tiempo )?(se )?(demora|demoran|tarda|tardan|falta)|cuanto (tengo|debo|hay) que esperar|(ya )?(me )?(van a|vienen a|viene a) (atender|contestar|responder)|cuando (me )?(atienden|atenderan|contestan|responden|van a)|sigo esperando|nadie (me )?(responde|contesta|atiende)|hay alguien|estan ahi|alguien (ahi|me atiende)|todavia no (me )?(atienden|contestan)|ya viene)\b/;

export function classify(message: string): Intent {
  const n = normalize(message);
  // Un mensaje sin letras ni números ("👍", "🙂", "!!") es un acuse, no una pregunta para el modelo ni para un asesor.
  if (!n) return 'thanks';
  if (IDENTITY_RE.test(n)) return 'identity';
  if (THANKS_RE.test(n) && n.length <= 40) return 'thanks';
  if (HUMAN_RE.test(n)) return 'human';
  if (isSensitive(n)) return 'sensitive';
  if (GREETING_RE.test(n) && n.length <= 30) return 'greeting';
  if (HELP_RE.test(n)) return 'help';
  return 'other';
}
