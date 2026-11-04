/**
 * Vocabulario para reconocer nombres de personas en el chat sin depender del modelo.
 *
 * - COMMON: palabras que nunca son un nombre de pila (artículos, preguntas, verbos conjugados, palabras del chat, del
 *   negocio, cargos y marcas). Cortan un nombre ("Juan Pérez identificado con…" → "Juan Pérez") y hacen que una frase
 *   corta ("hay vacantes", "precios", "Bancolombia") no se tome como nombre. Su plural también cuenta (isCommonWord).
 * - FIRST_NAMES: nombres de pila frecuentes. Dan confianza cuando el nombre llega sin "me llamo" y sin mayúscula, y
 *   ganan a COMMON ("me llamo Leo", "Domingo Pérez", "Soledad").
 * - SURNAMES: apellidos frecuentes. Después de un nombre de pila siguen el nombre aunque también sean palabras
 *   ("Carlos Mora", "Diana Cuesta", "Juan Plata"); un apellido conocido también da confianza ("wilmar gómez").
 * - PERSON_TITLES / ROLE_TITLES: tratamientos ("Dr.", "la señora") y cargos ("Gerente", "Asistente"). Se quitan al
 *   inicio de un nombre; un cargo solo, o seguido de otra palabra del cargo, no es un nombre.
 *
 * Todo va normalizado: minúsculas y sin tildes (la ñ se escribe como n, igual que en normalize()).
 *
 * El léxico amplio (miles de palabras comunes, marcas, nombres y apellidos que también son palabras) está en
 * lexiconWords.ts y se suma a estas listas.
 */
import { GENERAL_WORDS, MORE_BRANDS, MORE_FIRST_NAMES, MORE_SURNAMES, MORE_WORD_NAMES } from './lexiconWords';

const words = (s: string) => s.split(/\s+/).filter(Boolean);

const FUNCTION_WORDS = words(`
  a al ante bajo con contra de del desde durante en entre hacia hasta mediante para por segun sin sobre tras via
  el la lo los las un una unos unas y e o u ni que como cuando donde adonde cual cuales quien quienes cuanto cuanta
  cuantos cuantas porque porqu pq xq q k pues si no ya mas menos muy tan tanto tanta tantos tantas tambien tampoco aun
  todavia solo solamente siempre nunca jamas casi apenas bastante demasiado mucho mucha muchos muchas poco poca pocos
  pocas todo toda todos todas nada nadie algo alguien alguno alguna algun algunos algunas ninguno ninguna ningun otro
  otra otros otras mismo misma mismos mismas cada cualquier cualquiera mi mis tu tus su sus nuestro nuestra nuestros
  nuestras me te se le les nos yo usted ustedes vos ud uds ella ellos ellas ello este esta esto estos estas ese esa
  eso esos esas aquel aquella aquello aquellos aquellas aqui ahi alli alla aca asi bien mal mejor peor antes despues
  luego ahora hoy ayer manana tarde temprano pronto entonces tal vez quiza quizas acaso ademas incluso tipo vez veces
  pero sino aunque mientras osea
`);

const VERBS = words(`
  es son era eran fue fueron ser sea sean sido siendo soy eres somos estar estan estoy estas estamos estaba estaban
  estuve estado estaria hay habia hubo he has ha han hemos habra tener tengo tiene tienes tienen tenemos tenia tenian
  tuve tuvo hacer hago hace haces hacen hacemos hice hizo hecho haga hagan hagame poder puedo puede puedes pueden
  podemos podria podrian podrias pude pudo querer quiero quiere quieres quieren queremos quisiera queria necesitar
  necesito necesita necesitas necesitan necesitamos necesitaba deber debo debe debes deben debemos debia ir voy va vas
  van vamos iba fui ido dar doy da das dan dame deme denme dio di decir digo dice dices dicen dije dijo dicho diga
  digan dime digame ver veo ve ves ven vi vio visto saber se sabe sabes saben sabia supe conocer conozco conoce llamar
  llamo llama llaman llame llamen llamaron llamando llamado llamada llamadas llamenme llamame llamarme llamarlos
  escribir escribo escribe escriben escribi escribio escribieron escrito escribame escribanme escribeme pagar pago
  paga pagan pague pagaron pagando pagado cobrar cobro cobra cobran cobraron cobrando cobrado trabajar trabaja trabajan
  trabajando trabajamos atender atiendo atiende atienden atendieron atendiendo atienda atiendan buscar busco busca
  buscan buscando ayudar ayudo ayuda ayudan ayudame ayudeme ayudenme ayudar esperar espero espera esperan esperando
  espere esperame espereme esperen pasar paso pasa pasan pase pasame paseme pasenme pasaron hablar hablo habla hablan
  hable hablame hablemos hablando comunicar comunico comunica comunicarme comuniqueme comunicame comunican contactar
  contacta contactan contactaron contactarme enviar envio envia envian envie enviaron mandar mando manda mandan mande
  mandaron recibir recibo recibe reciben recibi recibio llegar llego llega llegan llegaron llegue venir vengo viene
  vienen vino seguir sigo sigue siguen segui quedar quedo queda quedan quede quedaron entender entiendo entiende
  entendi entendido comprender comprendo creer creo cree pensar pienso piensa sentir siento gustar gusta gustaria
  encanta parece preguntar pregunto preguntaba responder respondo responde responden respondan contestar contesto
  contesta contestan contesten perdona perdone disculpa disculpe disculpen olvidar olvide olvido recordar recuerdo
  acuerdo acuerda acorde importa cancelar cancelo cancela cancele consultar consulto revisar reviso revisa revisen
  verificar verifico abrir abren abre cerrar cierran cierra empezar empieza terminar termina salir sale salen entrar
  entra usar usa tomar toma tomen dejar dejo deja dejen poner pongo pone ponen mirar miro mire vea oiga oye escuche
  escucha leer lee leo aparecer aparece aparezco salio cambiar confirmar confirmo confirma demorar demora demoran
  demorando tardar tarda tardan tardando falta faltan faltar sirve sirven servir funciona funcionan existe existen
  ofrecer ofrecen ofrece manejar manejan maneja prestar prestan presta contratar contratan negociar tratar trata
  registrar reportar reportado reportada embargaron demandaron deber cuesta cuestan vale valen sale identificado
  identificada identifico identifica prefiero preferiria prefiere preferimos reservo reservar reservarlo reservarla
  decirlo darlo darla darlos compartirlo agradezco agradecido agradecida colabora colaborar colaborame indicar indica
  informar informa regala regalame regalan cotizar cotizo contrato contrata consigne consigno transferi abone abono
  mira miren resulta resulto acabo acaba acabe aguarda aguarde aguarden dele digale regalele cuentele pasele avisele
  permita permite permitame permiteme regale regaleme explica explique informe escucha escuche manda mande envia
  cuenta cuente quede quedamos ten tenga tengan sigan cumplo explicar contar mandar respeten respete respetar
`);

const CHAT_WORDS = words(`
  ok okey okay oki vale listo dale bueno buena buen gran claro perfecto excelente genial super chevere bacano gracias gracia
  porfa porfavor favor jaja jajaja jajajaja jeje jejeje jiji ja je hmm mmm mm aja eh ah oh uy ay pues ehh xd sip sii
  nop nel nopes ntp tmb tb entendido exacto correcto cierto obvio igual tranquilo tranquila ahorita momento momentico
  momentito permiso perdon saludos bendiciones amable atento atenta pendiente hola holi buenas buenos dias tardes
  noches chao adios bye hi hello test prueba pruebas probando asdf nose afirmativo negativo seguro bien
  gusto mucho encantado encantada igualmente sisas hagale dios anonimo anonima confidencial secreto secreta privado
  privada reservado reservada ninguna nadie normal nuevo nueva olvidalo olvidelo olvida olvidate dejalo dejelo
  dejemoslo cancelalo cancelala cancelen anula anular anulalo
  dele breve fresco fresca melo bacana parce parcero parcera mano mijo mija joven uyy uyyy uff ufff ayy wow guau ups
  epa ole ojo vaya caramba uju ujum jum mmmm feliz felices navidad noche fin semana amable amables listica
  alo hey plis pliss porfi porfis please sumerce patron patrona veci mierda
`);

/** Condiciones u orígenes de la persona ("soy víctima", "soy viuda", "soy paisa"): no son su nombre. */
const PERSON_CONDITIONS = words(`
  victima victimas viuda viudo huerfano huerfana adulto adulta anciano anciana campesino campesina desplazado
  desplazada discapacitado discapacitada enfermo enferma desempleado desempleada jubilado jubilada ama casa cabeza
  hogar soltero soltera casado casada separado separada divorciado divorciada embarazada paisa costeno costena rolo
  rola caleno calena pastuso pastusa santandereano santandereana boyacense antioqueno antioquena llanero llanera opita
  cachaco cachaca valluno valluna tolimense huilense caucano caucana migrante refugiado refugiada muchacho muchacha
  nino nina senora joven mujer hombre persona natural juridica suplantacion fraude estafa policia sobrina sobrino
  nieta nieto conductor conductora emprendedora emprendedor
`);

/** Ciudades y departamentos de Colombia: "Pasto" o "de Armenia" dicen de dónde es, no cómo se llama. */
export const PLACES = new Set(words(`
  medellin bogota cali barranquilla cartagena bucaramanga pereira manizales armenia ibague neiva pasto popayan monteria
  sincelejo valledupar riohacha quibdo tunja yopal villavicencio cucuta florencia leticia envigado itagui bello sabaneta
  rionegro soacha palmira tulua buenaventura cartago girardot zipaquira chia facatativa fusagasuga duitama sogamoso
  barrancabermeja apartado caucasia ipiales tumaco jamundi dosquebradas floridablanca giron piedecuesta malambo soledad
  antioquia cundinamarca santander boyaca valle cauca narino tolima huila meta caldas risaralda quindio cordoba sucre
  bolivar atlantico magdalena cesar guajira choco casanare arauca putumayo caqueta amazonas guaviare vaupes vichada
  guainia uraba
`));

const DOMAIN_WORDS = words(`
  telefono telefonos numero numeros celular cel movil fijo whatsapp wsp wasap watsap correo correos email mail
  direccion direcciones sede sedes oficina oficinas horario horarios servicio servicios cartera carteras deuda deudas
  pago pagos factura facturas credito creditos cuenta cuentas saldo saldos obligacion obligaciones empleo empleos
  trabajo vacante vacantes hoja vida cedula cedulas documento documentos pasaporte identificacion cc nit asesor
  asesora asesores asesoria abogado abogados abogada cobro cobros cobranza cobranzas conciliacion pqr pqrs queja
  quejas reclamo reclamos peticion informacion info ayuda pregunta duda dudas consulta problema problemas caso proceso
  procesos demanda embargo interes intereses mora cuota cuotas valor monto plata dinero pesos mil millones banco
  bancos almacen almacenes tienda empresa empresas compania entidad cliente clientes usuario usuaria usuarios chat bot
  robot humano persona personas gente ciudad pais sabado sabados domingo domingos lunes martes miercoles jueves
  viernes dia hora horas semana mes ano nombre nombres apellido apellidos completo link pagina web formulario boton
  app aplicacion tarjeta contrato referencia radicado codigo cita reunion visita precio costo tarifa descuento oferta
  legal juridico juridica call center recuperacion gestion atencion linea lineas area departamento recursos humanos
  rrhh talento seleccion hv curriculum convocatoria practicas pasantia aprendiz deudor deudora titular estudiante
  colombiano colombiana venezolano venezolana extranjero extranjera independiente empleado empleada pensionado
  pensionada comerciante empresario empresaria interesado interesada codeudor codeudora fiador fiadora familiar hijo
  hija esposo esposa madre padre mama papa hermano hermana amigo amiga tio tia abuelo abuela vecino vecina
  trabajador trabajadora general medellin bogota cali barranquilla cartagena colombia peru ecuador bolivia guatemala
  venezuela manizales bucaramanga cucuta ibague envigado itagui sabaneta rionegro menor mensaje mensajes respuesta
  datos dato numerito favorcito urgente rapido mismo requisito convenio honorario certificado certificacion paz
  salvo reporte prestamo libranza soat impuesto multa comparendo sucursal plazo cotizacion propuesta contratacion
  identidad ciudadania extranjeria registro civil nuip pep ppt carnet notificacion carta citacion juzgado tramite
  estado historial extracto recibo comprobante soporte transferencia consignacion efectivo transaccion cobrador
  cobradora gestor gestora mensajero acuerdos negociacion refinanciacion financiacion seguro seguros poliza tasa
  plan planes paquete producto productos marca marcas aliado aliados aliada aliadas presencia sitio portal
  plataforma correspondencia sms presencial virtual caja social mundo hipoteca hipotecario vehiculo carro moto
  apartamento arriendo matricula colegio universidad salud medicamento ferreteria mueble muebles almacen tienda
  negocio local drogueria supermercado chiste respuesta explicacion empresa calle correcta completa exacta exacto real
  verdadera verdadero actual anterior equivocada equivocado errada errado mala malo gratuita gratuito gratis online
  remota remoto laboral penal civil familia
`);

/** Bancos, billeteras, centrales de riesgo, operadores y almacenes: en el chat de cobranza nombran la entidad, no a la persona. */
const BRANDS = words(`
  bancolombia davivienda bbva nequi daviplata pse efecty baloto movistar tigo wom etb une avantel datacredito cifin
  transunion procredito falabella exito alkosto ktronix flamingo offcorss dupree azzorti finandina colpatria
  scotiabank itau occidente agrario bancamia mibanco lulo nubank nu rappi rappipay movii addi sistecredito
  credivalores crediorbe cobelen incomercio emermedica electrobello fianco fuller interactuar latam lebon luma tinkko
  baguer alianza branchos avianca codensa enel epm emcali vanti sura sanitas coomeva colsanitas compensar colsubsidio
  comfama comfenalco cafam colmena porvenir colpensiones dian sena icetex mercadolibre amazon google facebook
  instagram telegram tiktok netflix directv visa mastercard amex diners bancoomeva confiar cotrafa jfk juriscoop
  serfinanza tuya cencosud jumbo olimpica ara d1 makro homecenter totto bata comfandi
  sodimac jamar ecopetrol comcel yanbal credifamilia coopcentral fincomercio comultrasan crezcamos bancoldex
  banagrario avvillas pichincha gnb sudameris citibank ripley alkomprar electrojaponesa easy pricesmart isimo
  surtimax carulla colanta alpina postobon bavaria nutresa corona argos terpel primax natura esika avon lbel cyzone
  leonisa koaj bosi americanino chevignon zara mango claro
  ${MORE_BRANDS}
`);

/** Tratamientos de persona: se quitan antes del nombre ("Dr. Juan Pérez", "la señora Gloria Pérez"). */
export const PERSON_TITLES = new Set(words(`
  dr dra doctor doctora sr sra srta senor senora senorita don dona ing ingeniero ingeniera lic licenciado licenciada
  prof profe profesor profesora abg abogado abogada arq arquitecto arquitecta
`));
/** Cargos: "Soy Gerente de Cartera", "Soy Asistente Administrativa" no dicen el nombre. */
export const ROLE_TITLES = new Set(words(`
  gerente director directora jefe jefa coordinador coordinadora administrador administradora contador contadora
  asistente secretaria secretario auxiliar analista supervisor supervisora representante propietario propietaria
  dueno duena presidente presidenta lider encargado encargada ejecutivo ejecutiva tesorero tesorera socio socia
  vendedor vendedora asesor asesora agente operador operadora funcionario funcionaria
`));
/** Palabras que acompañan un cargo ("Asistente Administrativa", "Director Comercial"). */
const ROLE_WORDS = words(`
  administrativo administrativa comercial comerciales financiero financiera operativo operativa contable logistico
  logistica tecnico tecnica regional nacional senior junior responsable cartera ventas compras mercadeo talento
  humano juridico juridica legal general zonal integral externo externa interno interna principal
`);
export const TITLES = new Set([...PERSON_TITLES, ...ROLE_TITLES]);

/**
 * Lo que no es un nombre y faltaba en el léxico amplio: groserías e insultos ("gonorrea", "idiota"), apelativos que
 * nunca son un nombre ("princesa", "negrita"), creencias y cualidades ("soy cristiana", "soy honesto"), oficios que
 * también son apellidos ("soy pastor": tras un nombre de pila siguen siendo apellido, "Pedro Pastor") y palabras que
 * terminan en -is ("tesis", "análisis").
 */
const EXTRA_COMMON = words(`
  gonorrea gonorreas hijueputa hijueputas hijuepucha jueputa jueputas juepucha hp hpta hptas huevon huevona huevones
  guevon guevona guevones webon weon pirobo piroba pirobos pendejo pendeja pendejos maricon maricona maricones puta puto
  putas perra perras zorra zorras bobo boba bobos tonto tonta tontos idiota idiotas imbecil imbeciles sapo sapa sapos
  rata ratas careverga carechimba verga vergas mamon mamona lambon lambona lambones sinverguenza sinverguenzas ome
  ratero ratera bruto bruta cerdo cerda culo culicagado malparida cabron cabrona cretino cretina asqueroso asquerosa
  loca loco locos tarado tarada mongolico baboso babosa cansona cansones metiche
  princesa princeso reinita cielito negrita negrito belleza oro
  cristiana cristiano cristianos creyente catolica catolico evangelica evangelico adventista honesta honesto sincero
  sincera franca fiel monja monje misionero misionera minero minera rector rectora labradora labrador leal
  tesis analisis dosis oasis chasis sintesis parentesis hipotesis
`);

/**
 * Nombres que también describen a la persona o le hablan ("soy franco", "soy clara con usted", "soy pastor", "mi
 * reina"): en minúscula, tras "soy" o como respuesta suelta, no son el nombre; con mayúscula ("soy Franco", "Reina
 * Gómez", "Pastor Hernández") o con apellido sí.
 */
export const DESCRIPTIVE_NAMES = new Set(words(`
  clara claro dulce franco franca gentil modesto modesta justo justa amada amado benigno benigna bienvenido bienvenida
  candida candido placido placida primitivo prospero serena sereno severo severa marino pastor pastora reina rey
`));

/**
 * Apelativos de cariño o de trato ("linda", "mi reina", "veci", "parce"): en minúscula y sin "me llamo" le hablan al
 * bot; no son el nombre del visitante. "Linda" o "Cielo" con mayúscula sí pueden serlo.
 */
export const ENDEARMENTS = new Set(words(`
  linda lindo bella bello hermosa hermoso preciosa precioso princesa reina reinita rey cielo cielito corazon carino
  querida querido mami papi mamita papito mamacita papacito mija mijo mijita mijito nena nene amor vida vecina vecino
  veci parce parcero parcera hermano hermana mana mano manito sumerce patron patrona bebe negrita negrito gordita
  gordito flaca flaco mona mono muneca muneco chiquita chiquito bonita bonito guapa guapo lindura belleza amiga amigo
  cosita
`));

/** Palabras de uso diario (sin las marcas): una cartera que se llama así ("General", "Claro") es ambigua. */
export const EVERYDAY = new Set([
  ...FUNCTION_WORDS, ...VERBS, ...CHAT_WORDS, ...DOMAIN_WORDS, ...ROLE_WORDS, ...TITLES, ...PERSON_CONDITIONS, ...words(GENERAL_WORDS),
  ...EXTRA_COMMON,
]);
/** Palabras que no son un nombre de pila. */
export const COMMON = new Set([...EVERYDAY, ...BRANDS]);

/**
 * Formas verbales con el pronombre pegado ("cuéntame", "permítame", "explícame", "fíjate", "dímelo"): un pedido, no un
 * nombre. Se mira la vocal antes del pronombre; "Jaime" o "Vicente" no lo cumplen.
 */
const ENCLITIC = /^[a-z]{3,}[aei](me|te|nos|selo|sela|selos|melo|mela|telo|tela)$/;
export const isEnclitic = (w: string) => w.length >= 5 && ENCLITIC.test(w);

/** Nombres de pila frecuentes en Colombia y Latinoamérica. */
export const FIRST_NAMES = new Set(words(`
  aaron abel abraham adan adolfo adrian agustin alan albeiro alberto alcides aldair aldemar alejandro alex alexander
  alexis alfonso alfredo alirio alonso alvaro amador anderson andersson andres angel anibal antonio anyelo arbey
  argemiro ariel aristides aristobulo arley armando arnold arnulfo arturo augusto aurelio baltazar bayron benjamin
  bernardo brahian brahyan braian brandon brayan bryan camilo carlos cesar christian clemente conrado cristian
  cristhian cristobal ciro dagoberto dairo dairon damian daniel danilo dario darwin david deiby deiner deivid dennis
  didier diego dilan dylan domingo douglas duban duberney duvan eder edgar edgardo edier edilberto edilson edinson
  edison eduardo edward edwar edwin efrain efren eider elias eliecer eliseo elkin emanuel emerson emiliano emilio
  emilson emiro emmanuel enrique erick erik ernesto esneider esteban estiben estiven eugenio evelio ever ezequiel
  faber faiber fabian fabio federico felipe fernando fernely ferney fidel flavio francisco franco franklin freddy
  fredy gabriel gentil gerardo german gerson gilberto gildardo giovanni giovanny gonzalo gregorio guillermo gustavo
  hader hamilton harold harvey hector heiner henry heriberto hermes hernan hernando hollman horacio hugo humberto
  ignacio isaac isaias ismael israel ivan jacobo jader jaider jaime jair jairo james javier jefferson jeferson jefry
  jeisson jeison jeronimo jeyson jesus jhoan jhojan jhon jhonatan jhonier jhonny jhony jhorman jhovany jimmy joaquin
  joel johan john johnny jonas jonathan jonier jorge jose josue jovany jovanny juan julian julio keiner kevin
  leandro leider leiner leo leon leonardo leonel leonidas libardo lorenzo lucas luciano luis maicol manuel marco
  marcos mario marlon martin mateo matias mauricio mauro maximiliano michael miguel milton misael moises nairo neider
  nel nelson nestor nicolas nolberto norberto octavio olmedo olmer omar orlando orley oscar osvaldo oswaldo ovidio
  pablo patricio pedro rafael ramiro ramon raul reinaldo reinel rene reynaldo ricardo rigoberto robert roberto
  robinson rodolfo rodrigo rogelio rolando roman rosemberg rosendo ruben rubiel salvador samuel sandro santiago saul
  sebastian sergio silvio simon sneider stiven steven teodoro teofilo thiago tiago tobias tomas thomas ulises uriel
  valentin vicente victor weimar wilber wilder wilfer wilfredo wilington william willian wilmar wilmer wilson xavier
  yamid yeferson yeiler yeiner yeison yeisson yerson yesid yhon yhorman yimmy yonatan yonny yorman yovany yovanny
  adriana agustina aida alba aleida aleyda alejandra alexa alexandra alicia alix alma amalia amanda amelia amira
  amparo ana andrea angela angelica angie antonia araceli arelis argenis ariana asuncion astrid aura aurora beatriz
  belen berta bertha betty blanca brenda britney camila caridad carla carmen carol carolina catalina cecilia celeste
  celia cielo cindy clara claudia concepcion constanza consuelo cristina dahiana dahianna dalia damaris dania daniela
  dayan dayana dayanna deisy deyanira diana dilia dolores dora doris dulce edelmira edilma edith eliana elena elisa
  elizabeth elsa elvira emilia emma emperatriz eneida eneyda erica erika esperanza estefania estela ester esther
  estrella eucaris eugenia eva evelyn fabiola fanny fernanda flor francy gabriela geraldine gertrudis gilma gina
  gisela gladis gladys gloria graciela guadalupe heidi heidy helena hermelinda herminia hilda ilda ines ingri ingrid
  irene iris isabel isabela isabella ivonne jacqueline jaqueline janeth jasbleidy jazmin jenifer jennifer jenny jeny
  jessica jhoana jimena johana johanna josefina juana judith julia juliana julieta karen karina karol katalina
  katerine katherine keila kelly kimberly lady laura leidy leticia leydi libia ligia lilia liliana lina lisseth
  liseth lizet lizeth lorena lourdes lucia luciana lucy ludivia ludibia luisa luz luzdary luzmery luzmila magdalena
  maira manuela marcela margarita maria mariana mariangel maribel mariela marina marisol maritza marleny marta martha
  maryuri mayerli mayerly mayra melany melissa mercedes mery milagros milena miriam monica myriam natali natalia
  nataly nathalia naty nancy nelcy nelly nidia nieves noemi nohemy nohora norma nubia ofelia olga omaira onelia
  oneida oneyda orfa paola patricia paula paulina perla pilar piedad raquel rebeca regina remedios rocio rosa rosalba
  rosario rubiela ruth salome sandra sara sarah sharon shirley silvia sindy socorro sofia sol soledad sonia stefany
  stella susana tania tatiana teresa trinidad valentina valeria valery vanessa veronica victoria viviana wendy
  ximena xiomara yamile yanet yaneth yaqueline yazmin yeimi yeimy yenifer yenny yeny yeraldin yeraldine yesenia
  yesica yessenia yessica yohana yolanda yolima yomaira yorladis yuli yuliana yulieth yuliza yuly yurani yurany
  yurley yuri zenaida zoila zoraida zulma
  pascual dante brigitte odette lisette florencia valeria paz
  yarlenis yarleidis yarledis leidys leidis leydis yuranis yuleidis yuleisi marelys marelis dayanis yerlis dairis
  karelys karelis mileidis mileydis luzmeris darlis yurleidis nelis yeinis mairis glenis yoleidis yamiles ingris leida
  leyda zaida onelis yulis yarelis yudis yudith eudis edilsa dalgis dilsa nayelis yeimis kendris kelys yuris yurlis
  darlys yoiner yohanis dary dari darly maryuris neyla nely yaneris yenis dalys dayris yamith everth idalia idaly zully
  yaditza yordi pastor reina rey
  ${MORE_FIRST_NAMES}
`));

/** Apellidos frecuentes en Colombia (incluye los que también son palabras: Mora, Cuesta, Plata, Bello, Bueno…). */
export const SURNAMES = new Set(words(`
  acevedo acosta agudelo aguirre alarcon albarracin alegre alfonso alvarado alvarez alzate amado amaya anaya andrade
  angel angulo aponte aranda araque arango arboleda ardila arenas arevalo arias arrieta arroyave avila baena baquero
  barrera barreto barrios becerra bedoya bello beltran benavides benitez bermudez bernal betancourt betancur blanco
  blandon bolivar bonilla borja botero bravo bueno buitrago burgos bustamante bustos caballero cabrera caicedo
  calderon calvo camacho campo campos cano cardenas cardona carmona caro carrascal carreno carrillo carvajal casas
  castaneda castano castellanos castillo castrillon castro ceballos celis cely cespedes chacon chaparro chavez
  cifuentes clavijo contreras cordero cordoba coronado correa corredor cortes cruz cuartas cuellar cuervo cuesta daza
  delgado diaz dominguez duarte duque echeverri echeverry escalante escobar escudero espinosa espinoza espitia
  estrada fajardo farfan fernandez figueroa florez flores fonseca forero franco fuentes gaitan galeano galindo
  gallego gallo galvis gamba gamboa gamez garces garcia garzon gaviria gil giraldo gomez gonzalez granada granados
  guarin guerra guerrero guevara gutierrez guzman henao hernandez herrera hincapie holguin hoyos huertas hurtado
  ibarra iglesias isaza izquierdo jaramillo jimenez jurado lago lara lasso leal ledesma leguizamon leiva leon linares
  lizarazo llano loaiza lobo lombana londono lopera lopez lotero lozano lucumi lugo luna machado madrid maldonado
  manrique mantilla marin marquez martin martinez marulanda mayor mazo medina medrano mejia melo mena mendez mendoza
  meneses mercado mesa meza miranda mojica molina monroy monsalve montano monte montealegre montenegro montero montes
  montoya mora morales moreno mosquera munera munoz murillo naranjo narvaez navarro neira nieto nino noguera novoa
  nunez obando ocampo ochoa olaya olivares ordonez orozco orrego ortega ortiz osorio osorno ospina ossa otalvaro ovalle
  pabon pacheco padilla palacio palacios palomino pantoja parada pardo paredes parra pastor patino paz pelaez pena
  penagos penaloza perdomo perea pereira perez pico pimiento pineda pineros pino pinto pinzon plata polo porras posada
  posso prado pretel prieto puentes puerta pulido quevedo quiceno quintana quintero quinones quiroga quiroz ramirez
  ramos realpe rendon renteria restrepo rey reyes rico rincon rios rivas rivera rivero riveros robledo rocha rodas
  rodriguez rojas roldan romero rondon rosales rosas rosero rozo rubio rueda ruiz saavedra saenz salamanca salas
  salazar salcedo salgado salinas samper sanabria sanchez sandoval sanmiguel santamaria santana santos sarmiento
  sepulveda serna serrano sierra silva solano sossa sotelo soto suarez tabares tafur tamayo tapias tejada tellez
  tique tirado tobon toloza toro torres tovar triana trujillo tunjano ulloa upegui urbano urrea urrego uribe useche
  usuga valbuena valderrama valdes valencia valle vallejo vanegas varela vargas varon vasco vasquez vega vela
  velandia velasco velasquez velez vera vergara vidal villa villada villalba villamil villamizar villarreal villegas
  villota yanez yara yepes zabala zambrano zamora zapata zarate zea zuluaga hoz armas pascual
  calle corona caldas sucre santander giron cartagena buenaventura narino medellin toledo sevilla castilla barbosa
  villavicencio
  ${MORE_SURNAMES}
`));

/**
 * Nombres de pila que también son palabras ("domingo", "leo", "clara", "luz", "paz", "nel"): solos o con mayúscula
 * son un nombre; al inicio de una frase en minúscula ("domingo te los mando", "leo los mensajes") no.
 */
export const WORD_NAMES = new Set(words(`
  alba amparo angel aurora belen caridad cielo clara concepcion consuelo cruz dolores domingo dulce esperanza estrella
  flor fe gloria iris leo leon luz mar mercedes milagros nieves paz perla piedad pilar remedios rocio rosa rosario
  salvador simon socorro sol soledad trinidad victoria franco gentil nel ever modesto justo
  ${MORE_WORD_NAMES}
`));

/** Palabra común, o el plural de una ("precios", "tarifas", "sucursales"): no es un nombre. */
export function isCommonWord(w: string): boolean {
  if (COMMON.has(w)) return true;
  // "Barrios", "Cortés", "Casas": un apellido no se toma por el plural de una palabra común.
  if (SURNAMES.has(w)) return false;
  if (isEnclitic(w)) return true;
  if (w.length > 4 && w.endsWith('es') && COMMON.has(w.slice(0, -2))) return true;
  return w.length > 3 && w.endsWith('s') && COMMON.has(w.slice(0, -1));
}
