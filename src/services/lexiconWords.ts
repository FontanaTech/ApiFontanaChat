/**
 * Léxico amplio para reconocer nombres (generado y revisado en noviembre de 2026; ver lexicon.ts).
 *
 * - GENERAL_WORDS: palabras del español de Colombia que no son un nombre de pila (lo legal y financiero, oficios,
 *   parentescos, gentilicios, adjetivos, la vida diaria, palabras del chat, groserías y formas verbales). Se quitaron los
 *   nombres de pila que también son palabras ("rosa", "paloma", "linda") y las marcas (van en MORE_BRANDS).
 * - MORE_BRANDS: bancos, cajas de compensación, almacenes, operadores y entidades que se nombran en un chat de cobranza.
 * - MORE_FIRST_NAMES / MORE_WORD_NAMES / MORE_SURNAMES: nombres y apellidos que faltaban, en especial los que también son
 *   palabras ("Esmeralda", "Lucero", "Cadena", "Plaza"): así una palabra común no le quita el nombre a nadie.
 *
 * Todo va normalizado (minúsculas, sin tildes, la ñ como n).
 */

export const GENERAL_WORDS = `
  abajo abierta abierto abona abonada abonado abonan abonar abonarle abonaron abonen abrazo abrazote abri abrio abro
  absolutamente abstenganse abstengase abuelita abuelitas abuelito abuelitos aburrida aburrido abusiva abusivo abuso
  acaban acabar acabaron accesible accidente accion accionista account acepta aceptable aceptado aceptamos aceptan
  aceptar acepte acepten acepto acercarme acero acerquese aclara aclaracion aclarame aclarar aclare aclareme aclaren
  aclarenme aclaro acompanamiento acordada acordado acordamos acordar acordaron acosa acosado acosan acosando
  acosandola acosandome acosar acosen acoso acreditada acreditado acreedor acreedora acreedoras acreedores acta activa
  activo acto actuales actualice actualicen actualiza actualizacion actualizada actualizado actualizan actualizar
  actualizaron actualizo actualmente acusacion acusada acusado address adelantar adelante adelanto adentro adeuda
  adeudada adeudado adeudo adicional adiosito adjuntar adjunto admin administracion adolescente adolescentes adopcion
  aduana aduanera aduanero advisor afanada afanado afane afanes afecta afectada afectado afiliacion afiliada afiliadas
  afiliado afiliados afortunadamente afro afrocolombiana afrocolombianas afrocolombiano afrocolombianos afros
  afternoon afuera agenda agendar agende agent agosto agotada agotado agradece agradeceria agradecimiento agresion
  agricultor agricultora agricultoras agricultores aguacero aguantar aguanto aha aham ahh ahoritica ahorrador
  ahorradora ahorros ajajaja ajam ajena ajeno aki albacea albanil albaniles alcalde alcaldes alcaldesa alcaldesas
  alcanza alcanzar alcanzo aleluya aleman alemana alemanas alemanes alerta alias alimentaria alimentos alivio almuerzo
  aloha aloo alrededor alright alta alternativa alto altura alumna alumnas alumno alumnos always amabilidad
  amablemente amanecer amarilla amarillo amazing ambas ambos ambulante ambulantes amen amenacen amenaza amenazado
  amenazan amenazando amenazandola amenazar amenazaron amenazo americana americanas americano americanos amigable
  amigazo amiguis amiguita amiguito amistosa amistoso amix amnistia amor amorcito amortizacion amplia amplio ancha
  ancho and andale ando anexo angustiada angustiado animal animo aniversario anoche anochecer anotado ansiedad answer
  anteayer antecedentes antenoche anteriores anteriormente anticipada anticipado anticipo antier antigua antiguo anual
  anulacion anulada anulado anulen apagada apagado aparecen aparecio aparentemente aparezca aparte apelacion aplazar
  apoderada apoderadas apoderado apoderados apodo aporte apostilla apostillada apostillado apoyar apoyen apreciada
  apreciado aprendices aprobacion aprobada aprobado aproximadamente apto apure apurele arabe arabes arbitraje arbitro
  archivo arcos arepa argentinas argentino argentinos armero arre arregla arreglado arreglar arreglemos arreglen
  arreglo arrendador arrendadora arrendadoras arrendadores arrendamiento arrendataria arrendatarias arrendatario
  arrendatarios arresto arriba arroz artesana artesanas artesano artesanos articulo artista artistas asalariada
  asalariado asamblea asap aseador aseadora aseadoras aseadores asegurada asegurado asegurar aseguro asequible
  asistencia asociada asociadas asociado asociados asumir asumo asunto asustada asustado atardecer atendeme atendemos
  atenderla atenderle atenderlo atenderme atenderte atendes atendi atendia atendida atendido atendio atentamente
  atiendame atiendanme atiendes atras atrasada atrasado atrase atraso atreven audiencia audio auditor auditora
  auditoras auditores auditoria aumentaron aumento ausente autentica autenticacion autenticada autenticado autentico
  auto automatica automatico autorice autoriza autorizacion autorizada autorizado autorizar autorizo auxilio avalista
  avaluo aveces avemaria avemariapues avenida averiguar averigue avion avisa avisale avisame avisar avisarle avise
  aviseme avisen avisenle avisenme aviso avispada avispado awesome ayayay ayudada ayudado ayudamos ayudando ayudandole
  ayudandome ayudante ayudantes ayudaria ayudarla ayudarle ayudarles ayudarlo ayudarme ayudarnos ayudaron ayudarte
  ayudas ayudaste ayude ayuden ayudenle ayudenlo ayudenos ayudes babe baby bacan bacanisimo bachiller bachillerato
  bachilleres bacteriologa bacteriologas bacteriologo bacteriologos bad bah baibai bailarin bailarina bailarinas
  bailarines baja bajar bajen balance banca bancaria bancario bano banquera banquero barajas barata baratas barato
  baratos barbera barberas barbero barberos barranquillera barranquilleras barranquillero barranquilleros barrio
  barros basicamente basura bateria bautizo beautiful bebe bebecita bebes bebita bebito beca beige bendecida bendecido
  bendicion bendiga beneficiaria beneficiarias beneficiario beneficiarios beneficio berraca berraco besito beso besos
  best bici bicicleta bienvenida billete billon bimestral bimestre birthday bisabuela bisabuelas bisabuelo bisabuelos
  bisnieta bisnietas bisnieto bisnietos blackfriday blanda blando bloque bloquea bloqueada bloqueado bloquean bloquear
  bloquearon bloquee bloqueo bnas bno boca boda bodega bogotana bogotanas bogotano bogotanos boleta boliviana
  bolivianas boliviano bolivianos bolsa bolso bombera bomberas bombero bomberos bonificacion bonita bonito bono bonos
  borra borrado borrar borrarme borren borrenme borro borrosa borroso boss botas boy brasilena brasilenas brasileno
  brasilenos brazo brillante brindar brindarme bro broder broma bromeando bromita brother brutal bsos bss btw buddy
  buenasnoches buenastardes buendia buenisima buenisimo buenosdias bufete bug bumangues bumanguesa bumanguesas
  bumangueses burda bus buscado buscamos buscarla buscarlo buscarme buscaron buses buseta business busque busquelo
  busquen cachai cachivaches caducada caducado caducidad cafe cafeteria caficultor caficultora caficultoras
  caficultores cajera cajeras cajero cajeros calamidad caldense caldenses calendario caliente calificacion callcenter
  callejas callense callese calma calmada calmado calmar calmate calmense calmese calor cama camarada cambia cambiado
  cambian cambiando cambiarlo cambiaron cambie cambien cambio camellando camellar camello camion camionera camioneras
  camionero camioneros camioneta camisa camiseta campana canadiense canadienses canas cancel cancelacion cancelada
  cancelado cancelamos cancelan cancelando cancelara cancelare cancelarla cancelarle cancelarlo cancelaron cancelaste
  cancelelo cancelenlo canceles cancer cancion candidata candidatas candidato candidatos canon cansada cansado cansan
  cansaron cantante cantantes cantidad capaces capacidad capacitacion capaz capital capitalina capitalinas capitalino
  capitalinos capitan capitana capitanas capitanes captura capturada capturado cara caracoles caraquena caraquenas
  caraqueno caraquenos caras caray carcel cargada cargado cargador cargaron cargo carino carisima carisimo carnal
  carnala carnalito carne carnicera carniceras carnicero carniceros carpintera carpinteras carpintero carpinteros
  carrera carretera carrito carros cartagenera cartageneras cartagenero cartageneros casas casera caseras casero
  caseros casita castigada castigadas castigado castigados castigo catira catire catorce causa cautelar cayo cdt
  cedente celador celadora celadoras celadores cell cellphone celu cena centavo centena centenar centrales centro
  cerca cercana cercano cero cerquita cerrada cerrado cerraron cerre certificada cerveza cesante cesantia cesion
  cesionario chabon chaito chale chama chamaca chamaco chamas chamba chambear chamita chamito chamo chamos chance
  chanfle chanza chaolin chaqueta chatbot chateando chatear chateo chau che checheres check chef chefs cheque chequera
  chica chicas chicharron chichigua chico chicos chida chido chilena chilenas chileno chilenos chill chimba chimbo
  chin china chinas chinita chinito chino chinos chip chiqui chiquilla chiquillo chiquita chiquitas chiquitica
  chiquitico chiquito chiquitos chispas chistosa chistoso chocoana chocoanas chocoano chocoanos chofer choferes
  christmas ciao ciega ciegas ciego ciegos cien ciento cierre cierro cierta ciertas ciertisimo ciertos cinco cincuenta
  cirugia cirujana cirujanas cirujano cirujanos citada citado citaron ciudadana ciudadanas ciudadano ciudadanos
  civilista claramente clarin clarinete clarisimo claros clase clausula clave click client clienta clientas clima
  clonacion clonada clonado clonaron coactiva coactivo cobertura cobraba cobraban cobrada cobrados cobrale cobramos
  cobrandole cobrandome cobrandonos cobraran cobrarle cobrarles cobrarlo cobrarme cobras cobraste cobre cobrele cobren
  cobrenle cobrenme cobres cocina cocinera cocineras cocinero cocineros code colaborado colaborador colaboradora
  colaboradoras colaboradores colaboran colaborando colaboraria colaborarle colaborarme colabore colaboreme colaboren
  colaborenme colaboro colega colegas colgado colgar colgaron colgo colgue colilla color colores comadre comadres
  comadrita comenta comentar comentarle comentaron comento comercializadora comida comienzo comisario comision
  comoesta compa compadre compadres compadrito compai companera companeras companero companeros comparti compartir
  comparto compas compatriota compatriotas competencia compinche compita compleja complejo complementaria
  complementario completamente completas completos complicada complicado comportamiento compra comprado comprador
  compradora compradoras compradores comprar compraron compraventa compre comprenda comprende comprendi compro
  comprometerme comprometi comprometo compromiso computador computadora comun comuna comunes comunicada comunicado
  comunicador comunicadora comunicadoras comunicadores comunicamos comunicando comunicandome comunicarle comunicarnos
  comunicaron comunicarse comunicate comunique comuniquen comuniquenme comuniquense comuniquese concejal concejala
  concejalas concejales concepto conciliador conciliadora conciliar concordato concubina concubinas concubino
  concubinos condena condenada condenado condicion condonacion condonada condonado condonar condonen confeccionista
  confeccionistas confianza confirmada confirmado confirmame confirman confirmando confirmarle confirmarlo confirmarme
  confirmaron confirme confirmelo confirmeme confirmen confirmenme conflicto conforme confundi confundida confundido
  confundir confusa confuso congelada congelado congelan congelar congelaron congreso conjunto conocen conoci conocida
  conocidas conocido conocidos conocio consegui conseguir consentimiento conserje conserjes consigna consignado
  consignan consignar consignarle consignaron consignen consigo consorcio constantemente constitucion constitucional
  constructoras constructores consuegra consuegras consuegro consuegros consulado consultando consulte consultor
  consultora consultoras consultores consultoria consultorio consumidora consumidoras consumidores contabilidad
  contact contactado contactame contactando contactarla contactarle contactarlo contactarlos contactarnos contactarte
  contactcenter contacte contacteme contacten contactenme contacto contactos contado contame contarle contaron conte
  contenciosa contenciosas contencioso contenciosos contenta contestaba contestado contestale contestame contestando
  contestarle contestarme contestaron contestarte contestas contestaste conteste contestele contesteme contestenle
  contestenme contestes continua continuar continuo conto contralor contralora contraparte contrasena contratado
  contratante contrate contratista contratistas contribucion contribuyente convendria conviene conyugal conyuge
  conyuges cool cooperativo copada copado copago copia copiado copias corazon corazoncito cordial cordialmente coreana
  coreanas coreano coreanos coronel coroneles corotos corporativa corporativo corrales correctamente correctas
  correctos corregido corregimiento corregir correito corresponde corresponden corriente corrige corrigieron corrija
  corrijan corrijo corrupcion corta cortada cortado corte corto cosa cosas cosita cosito coso costarricense
  costarricenses costosa costoso costurera costureras cotice cotitular cotiza cotizante covid crea crediticia
  crediticio creen crei creia creido crimen cripto criptomoneda crisis crush cuaderno cuadra cuadrado cuadrante
  cuadros cuarenta cuarentena cuarto cuartos cuate cuatito cuatro cuatrocientos cubana cubanas cubano cubanos cucha
  cuchas cuchita cuchito cucho cuchos cucutena cucutenas cucuteno cucutenos cuelga cuelgan cuelgo cuello
  cuentahabiente cuentale cuentame cuentan cuenteme cuenten cuentenle cuentenme cuento cuero cuerpo cuevas cuidado
  cuidador cuidadora cuidadoras cuidadores cuidate cuidense cuidese culebra culpa cultivador cultivadora cultivadoras
  cultivadores cumple cumpleanos cumplen cumpli cumplida cumplido cumplimiento cumplio cumplir cunada cunadas cunado
  cunados cupo cupon curador curadora curso custodia customer cute daba daban dada dado dama damas damos danada danado
  dando dandome dano daran dare darle darles darme darnos darte data datafono date day deacuerdo dear deba debajo
  deban debera debere deberia deberian deberias debiamos debian debida debido debiendo debiera debieron debil debio
  debiste debitar debitaron debito decada decena decepcionada decepcionado deci decia decian decias decile deciles
  decima decime decimo decimos decirle decirles decirme decirte decis decision declaracion declarante decreto dedo
  deduccion deducible defensa defensora definitiva definitivamente definitivo defuncion dejada dejado dejala dejale
  dejame dejamos dejan dejando dejarle dejarlo dejarme dejarnos dejaron dejas dejaste deje dejela dejele dejeme
  dejemos dejenla dejenlo dejenme dejenos dejes delante deles delito delivery demandada demandadas demandado
  demandados demandan demandante demandar demandarlo demandarlos demandarme demanden demando demas demasiadas demonios
  demorada demorado demoraron demore demos den dentista dentro denuncia denuncian denunciar denunciare denunciarlos
  denunciaron denuncie denuncio departamental dependiente deporte deportista deportistas depositar deposite deposito
  depronto derecha derecho derepente des desactualizada desactualizado desalojo desarrollador desarrolladora
  desarrolladoras desarrolladores desayuno desbloqueo descanse descargada descargado descargar descargue desconoce
  desconocida desconocido desconozco descontar descontaron descuentan desea deseaba desean desembolsada desembolsado
  desembolso desempleo deseo desesperada desesperado despachador despachadora despachadoras despachadores despacho
  despacio despacito desparche despedida despedido despidieron despido desprendible detalle detencion detener detengan
  detenida detenidas detenido detenidos detras deuna deveras devolucion devolver devolverme devolvieron devuelto
  devuelva devuelvan devuelve devuelvo diabetes diablos diagnostico diagonal diaria diariamente diario diciembre
  diciendo diciendole diciendome dictamen diecinueve dieciocho dieciseis diecisiete diente diera dieron diferente
  diferentes dificil dificiles dificultad difunta difuntas difunto difuntos digales digalo digamos diganle diganles
  diganme digas digitador digitadora digitadoras digitadores digital dijera dijeran dijeron dijimos dijiste diligencia
  diligenciar diligencie dilo dimelo dimos diosito diosmio diploma dira diran dire directa directamente directiva
  directo diria dirijase disculpame disculpar disculpeme disculpenme disenador disenadora disenadoras disenadores
  disponible dispuesta dispuesto distancia diste distinguida distinguido distinta distinto distribuidor distribuidora
  distribuidoras distribuidores divertida divertido divisa divorcio dizque dlb dnd doble doc doce docena docente
  docentes doctorcita doctorcito dolar domestica domesticas domestico domesticos domiciliaria domiciliarias
  domiciliario domiciliarios domicilio dominical dominicana dominicanas dominicano dominicanos donacion done dorada
  dorado dos doscientos dotacion download droga drogas dsps dtb ducha dudar dude dudo dudosa dudoso dura duro echado
  echaron eche ecommerce economica economico economista economistas ecuatoriana ecuatorianas ecuatoriano ecuatorianos
  edad edificio educada educado educador educadora educadoras educadores educativa educativo efectiva egreso ehm
  ejemplo ejercicio electricista electricistas electronica electronico elimina eliminacion eliminado eliminar
  eliminarme eliminaron eliminen eliminenme elimino embajada embarazo embarga embargable embargada embargadas
  embargado embargados embargan embargar embargarlo embargarme embarguen embarrada embolato emergencia emergente emm
  emocional emoji empezaron empezo empiezan empiezo emplazada emplazado empleador empleadora empleadoras empleadores
  emprendimiento empresarial encendida encendido encima encontrado encontrar encontraron encontre encontro encuentra
  encuentran encuentre encuentro endeudada endeudado endeudamiento enero enfermedad enfermera enfermeras enfermero
  enfermeros enfrente enganan enganando enganar enganaron enlace enojada enojado enorme enseguida enserio entendemos
  entenderme entendes entendia entendida entendiendo entendieron entendio entendiste entera enterada enterado entere
  entero entienda entiendame entiendan entiendanme entienden entiendes entierro entraba entrado entramos entran
  entrando entrante entraron entrega entregado entregar entregaron entrego entregue entren entrenador entrenadora
  entrenadoras entrenadores entro enviada enviado enviados enviale envialo enviame enviamos enviando enviaran enviare
  enviaria enviarla enviarle enviarlo enviarme enviarte envias enviaste enviele envielo envieme envien envienlo
  envienme envies epale epoca equipo equivocadas equivocados equivocan equivocaron equivocarse equivoque eras erronea
  erroneas erroneo erroneos error escolta escoltas escriba escribale escriban escribanle escribas escribele escribes
  escribia escribian escribiendo escribiendole escribiendome escribime escribimos escribire escribirle escribirles
  escribirme escribirte escribis escribiste escrita escritor escritora escritoras escritores escritura escuchame
  escuchan escuchar escucheme escuchen escuchenme escucho escuela esfero espalda espanol espanola espanolas espanoles
  especial especialista especializada especializado especialmente esperaba esperada esperado esperamos esperandolo
  esperare esperaria esperarla esperarlo esperarme esperaron esperarte esperas esperate esperemos esperenlo esperenme
  esperenos esperes esperese esquina estabas establecimiento estacion estadounidense estadounidenses estafador
  estafadora estafan estafando estafar estafaron estando estara estare estatuto esten estes estilista estilistas
  estimada estimadas estimado estimados estomago estres estresada estresado estudio estupenda estupendo estuviera
  estuvieron estuvo etapa europea europeas europeo europeos evening evitar eviten exactamente exactas exactos examen
  excellent exclusion excompanera excompaneras excompanero excompaneros excuse exenta exento exesposa exesposas
  exesposo exesposos exige exigen exigibilidad exigible exigimos exigir exija exijan exijo exjefa exjefas exjefe
  exjefes exmarido exmaridos exmujer exmujeres exnovia exnovias exnovio exnovios expareja exparejas expedida expedido
  expediente experta experto explicada explicado explicale explicame explicamos explican explicando explicandome
  explicaria explicarle explicarles explicarme explicaron explicaste explico expliquele expliqueme expliquen
  expliquenme exportacion exportador exportadora exterior extorsion extra extrajudicial extrajudiciales extrajuicio
  extrana extrano extras extraviada extraviado extravio facil faciles facilitar facilitarme faciliteme facilito
  facturacion fake falla fallecida fallecidas fallecido fallecidos fallecimiento fallecio fallo falsa falsas false
  falsificacion falsificada falsificado falso falsos faltaba familias family fantastic fantastica fantastico faq
  farmaceuta farmaceutas fase fastidian fastidiando fastidiar fatal fea febrero fecha fechas feed feedback felicidades
  felicitaciones felizdia femenina femeninas femenino femeninos feo feriado festivo festivos fiada fiado fiebre fiesta
  fijate fijese fijisimo file final finales finalmente financiada financiado financiamiento financiar finca finde fine
  finiquito firma firmada firmado firmar firmaron firme firmo fiscal fiscales fisica fisico fisioterapeuta
  fisioterapeutas flaca flaco flaquita flaquito flujo follow followers fome fondos for forma formal formato formula
  fotico foto fotocopia fotografa fotografas fotografo fotografos francesa francesas franceses franquicia fraudulenta
  fraudulento frecuencia frecuente frecuentemente free freelance freelancer fregada fregado fregando fregar fria
  friega friegan frieguen friend frio fruta fuchi fucsia fuera fueran fueras fuerte fuese fuimos fuiste fulana fulanas
  fulanita fulanito fulano fulanos full fullname funcionar funciono funeral funerario furiosa furioso futbol futura
  futuro gafas ganadera ganaderas ganadero ganaderos ganancia ganar ganas gano garante garantia garantizada
  garantizado garantizar garantizo garganta gaseosa gasolina gastar gaste gasto gato gemela gemelas gemelo gemelos
  genera generalmente generan gentileza gerencia gestiona gestionan gestionar gif gigas girar girl giro gitana gitanas
  gitano gitanos golpe good goodbye goodnight gorda gordita gordito gordo grabando grabar grado grande grandes grasia
  gratuidad gratuitas gratuitos gravamen grave grax graxias grcs great gringa gringas gringo gringos gripa gripe gris
  gritan gritaron grosera grosero grs gruesa grueso grupo guacala guacatela guajira guajiras guajiro guajiros guapa
  guapo guarda guardas guardia guardias guaro guasap guatemalteca guatemaltecas guatemalteco guatemaltecos guayabo
  guera guero guey guita gustan gustazo guys habeas haber habian habido habiendo habilitada habilitado habitacion
  habito hablado hablamos hablarle hablarles hablarme hablaron hablarte hablas hableme hablen hablenle hablenme hables
  habran habria hacerle hacerlo hacerme hacian haciendo hackeada hackeado hackearon hackeo hacker hagalo hagamos
  hagamosle haganlo haganme hagas haha hahaha haitiana haitianas haitiano haitianos hambre happy hara haran hare
  haremos haria harta harto hastaluego hastamanana hastapronto haya hayan hazlo hazme hecha hehe helada helado hellou
  helo help here heredera herederas heredero herederos herencia herida hermanastra hermanastras hermanastro
  hermanastros hermanazo hermanita hermanitas hermanito hermanitos hermosa hermoso hermosura herrero hibrida hibrido
  hiciera hicieran hicieron hicimos hiciste higuera hihi hii hijastra hijastras hijastro hijastros hijita hijitas
  hijito hijitos hijole hipotecaria hipotecarias historia hla holaa holis holita holiwis hombe hombro home hondurena
  hondurenas hondureno hondurenos honestamente honey horrible hospitalizada hospitalizadas hospitalizado
  hospitalizados hostigamiento hostigan hostigando hostigar hotel how hrs hubiera hubieran huella hueso huevo human
  humana humanas humedad humilde hurra hurto ibaguerena ibaguerenas ibaguereno ibaguerenos ibas idea ideal
  identificarme iguala iguales igualita igualito ijole ilegal ilegalidad ilegible ilegitima ilegitimo ilicita ilicito
  imagen importacion importador importadora importan importante importantes imposible imprevisto impulsador
  impulsadora impulsadoras impulsadores inactiva inactivo inbox incapacidad incapacitada incapacitadas incapacitado
  incapacitados incapaz incentivo inclusive incobrable incognita incognito incompleta incompletas incompleto
  incompletos inconforme inconveniente incorrecta incorrectas incorrecto incorrectos increible incumpli incumplida
  incumplido incumplimiento indefinida indefinido indemnizacion indicarme indico indigena indigenas indignada
  indignado indique indiqueme indiquen indirecto individuo individuos industria industrial inembargable inexacta
  inexacto infante inferior infinitamente infinitas informada informado informal informales informame informamos
  informan informando informandole informarle informarles informarme informaron informarte informeme informen
  informenme informo infraccion ingles inglesa inglesas ingleses ingresar ingrese ingreso inhabilitada inhabilitado
  inicial inicio inmediata inmediatamente inmediato inmigrante inmigrantes inmobiliario inmueble innecesario inquilina
  inquilinas inquilino inquilinos insatisfecha insatisfecho inscrita inscrito insegura inseguro insista insistan
  insistas insiste insisten insistente insistentes insisti insistiendo insistieron insistimos insistio insistir
  insisto insolvencia insolvente inspector inspectora inspectoras inspectores instalador instaladora instaladoras
  instaladores instante instructor instructora instructoras instructores instrumentador instrumentadora
  instrumentadoras instrumentadores insultan insultaron intenta intentado intentando intentar intente intento interesa
  interesante interior intermediaria intermediario internacional intimidacion intrafamiliar inutil invalida invalidez
  invalido inventan inventario inversion inversionista investigacion investigada investigado investigador
  investigadora investigadoras investigadores invierno iran ire iremos irme irreal irrespetan irrespetar irrespetaron
  irresponsable irse islena islenas isleno islenos issue italiana italianas italiano italianos iva izquierda jajaj
  japones japonesa japonesas japoneses jardin jardinera jardineras jardinero jardineros jartera jefazo jefecita
  jefecito jelou jodan jode joden joder jodida jodido jodiendo jojo jornada jornal jornalera jornaleras jornalero
  jornaleros jovencita jovencitas jovencito jovencitos joya jsjs jsjsjs jubilacion judiciales jueces juego juez jueza
  juezas jugador jugadora jugadoras jugadores jugo juicio juiciosa juicioso junio junta juntas junto juntos
  juramentada juramentado jurisdiccion jurisprudencia jurista juro justamente key kids kien kiero kilometro labor
  laborales laboralista laburar laburo ladron ladrona lagos lamentablemente lamento lapiz lapso larga largo lastname
  later latina latinas latino latinos lavado leche leen legado legalidad legible legitima legitimo lei leido lejana
  lejano lejos lenta lento letra leve libro licencia licita licito ligera ligero like limitada limite limpio lindo
  lindura lio liquidacion liquidada liquidado liquidador liquidadora liquidar liquiden liquidez lista listas listico
  listos literal literalmente litigante litigio live liviana liviano llamaba llamaban llamabas llamadita llamala
  llamale llamalo llamamos llamandola llamandole llamandolo llamandome llamandonos llamara llamaran llamare llamaremos
  llamaria llamarla llamarle llamarlo llamarnos llamarse llamas llamaste llamela llamele llameles llamelo llameme
  llamemos llamenla llamenlo llames llanos llave llavecita llaveria llegaba llegado llegando llegara lleguen llena
  llenar llene lleno lleva llevado llevan llevar llevaron llevo lluvioso localidad locutor locutora locutoras
  locutores login logout lograr logre logro lol lote love lovely lucro lugar madam madero madrastra madrastras madrina
  madrinas madrugada maestra maestras maestria maestro maestros magistrada magistrado magnifico maleta malisima
  malisimo maltrato maluca maluco mamacita mamacitas mamado mamasita mamera mami mamis mamita mamitas man manager
  mandada mandado mandale mandalo mandame mandamos mandando mandaran mandare mandaria mandarla mandarle mandarles
  mandarlo mandarme mandarte mandas mandaste mandataria mandatario mandelo mandeme manden mandenlo mandenme mandes
  manejando manejo manera manes manicurista manicuristas manita manito manizalena manizalenas manizaleno manizalenos
  manual manzana maquillador maquilladora maquilladoras maquilladores maracucha maracuchas maracucho maracuchos
  maravilla maravillosa maravilloso marcado marcale marcame marcan marcando marcar marcarle marcarme marcaron marcaste
  marido maridos marital marketing marque marquele marqueme marquen marquenme marron marzo mascota masculina
  masculinas masculino masculinos masomenos match maternidad matrimonio maybe mayo mayor mayordoma mayordomas
  mayordomo mayordomos mayores mayorista mecanica mecanicas mecanico mecanicos mecato media mediacion mediador
  mediadora mediana mediano medianoche medica medicas medicina medico medicos medida medio mediodia meeting megas meh
  melliza mellizas mellizo mellizos meme mengana menganas mengano menganos mensajear mensajera mensajeras mensajeria
  mensajito mensual mensuales mensualidad mensualmente mental mentir mentira mercaderia mercaderista mercaderistas
  mercancia mercantil merece merezco mesera meseras mesero meseros message mestiza mestizas mestizo mestizos mexicana
  mexicanas mexicano mexicanos mhm microempresa microempresaria microempresarias microempresario microempresarios
  miedo miembro miembros miente mienten mijita mijitas mijito mijitos milgracias militar militares millon min minima
  minimo minorista mintiendo mintieron minuta minutico minutito minuto minutos mirando mister mitad mobile modelo
  modelos moderadora moderna moderno modista modistas modo mojada mojado molesta molestaba molestaban molestada
  molestado molestan molestando molestandola molestandolo molestandome molestandonos molestar molestarla molestarle
  molestarlo molestarlos molestarme molestarnos molestaron molestarte molestas moleste molesten molestes molestia
  molesto molinero mona moneda monedero monita monito monitor monitora monitoras monitores mono month monton mor
  morada morado moratoria moratorio morning morosa morosas morosidad moroso morosos mostrar mostrarme motivo
  movimiento msg msj muchachita muchachitas muchachito muchachitos muchisima muchisimas muchisimo muda mudamos mudanza
  mudas mude mudo mudos muela muerta muertas muerte muerto muertos muestra muestrame muestreme mulata mulatas mulato
  mulatos multada multado muneca muneco municipal municipio murio musica musicas musico musicos nacimiento nacion
  nadamas nadita nah name nanai nanay naranja naranjas narinense narinenses nariz natillera necesaria necesario
  necesitaban necesitado necesitando necesitaron necesite necesiten negada negado negar negaron negligencia negocia
  negociado negociamos negocian negociarlo negocie negra negro nena nenas nene nenes nenita nenito nerviosa nervioso
  neta never nevera news nice nidea niega niegan niego night nitido nocturna nocturno nomas nomina nones nope
  normalizacion normalizada normalizado normalmente normas normativa normatividad normativo norte norteamericana
  norteamericanas norteamericano norteamericanos nosvemos not nota notarial notariales notarias notario notarios notas
  noticia notifica notificada notificado notifican notificar notificarle notificaron notifico notifique notifiquen
  novecientos novela novena noveno noventa novia novias noviembre novio novios now nro nse nube nublado nuera nueras
  nuevamente nuevas nueve nuevecita nuevecito nuevos nula nulo num number obligada obligado obligatoria obligatorio
  obra obrera obreras obrero obreros obrigado obvi obviamente ocasion occidental ochenta ocho ochocientos octava
  octavo octubre ocupacional ocupada ocupado ocurre ocurrio odontologa odontologas odontologo odontologos oeste
  ofenden ofendido office offline oficial oficiales oficio ofrecieron ofrezco ohh oido oigame oigan oigo oir ojala
  ojito oka okei okidoki okis okok olivo olvidada olvidado olvidan olvidando olvidarme olvidaron olvidaste olviden
  olvides olvidese ombe omg once onda onerosa oneroso oops opcion opcional opciones operacion operaria operarias
  operario operarios operaron orale oralidad orden order ordinaria ordinario oriental oriente original originales
  oriunda oriundas oriundo oriundos oscura oscuro otono outlet oyen paciente pacientes pactada pactado pactar
  padrastro padrastros padrino padrinos padrisimo pagaba pagaban pagada pagadera pagadero pagadiario pagador pagadora
  pagale pagalo pagame pagamos pagandole pagara pagaran pagare pagaremos pagaria pagarla pagarle pagarles pagarlo
  pagarlos pagarme pagarse pagarte pagas pagaste page paguele pagueles paguelo paguemos paguen paguenle pagues paila
  pailas paisana paisanas paisano paisanos pan pana panadera panaderas panaderia panadero panaderos panamena panamenas
  panameno panamenos panas pandemia panita pantalla pantallazo pantalon papacito papacitos papasito papel papi papis
  papito papitos papucho par paraguaya paraguayas paraguayo paraguayos paran parar pararon parcerazo parcerita
  parcerito parche parcial pardon pare parecen parecer parecia parecida parecido parecio pareja parejas paren parenle
  parezca parienta parientas pariente parientes paro parque parqueadero parranda parte particular particulares partido
  parto party pasaba pasada pasadas pasado pasados pasaje pasale pasalo pasamos pasando pasante pasarle pasarlo
  pasarme pasas pasaste paselo pasen pasenle paseo pasivo pass password pastilla pata patente paternidad patio
  patrimonio patroncita patroncito patrono patrullera patrulleras patrullero patrulleros payasa payasas payaso payasos
  pdf peaje pecho pedacito pedazo pedi pedia pediatra pediatras pedida pedido pedile pedime pedimos pedir pedirle
  pedirles pedis pediste pelada peladas pelado pelados pelaita pelaito pelao pelicula pelo peluquera peluqueras
  peluquero peluqueros penales penalidad penalista penalizacion penalizada penalizado pendientes pending pensaba
  pensando pense pensional penultima penultimo people pequena pequenas pequenito pequeno pequenos perder perdi perdida
  perdido perdio perdoname perdonar perdoncito perdoneme perdonen perdonenme pereirana pereiranas pereirano pereiranos
  perencejo pereza perfect perfecta perfectamente perfil periodista periodistas periodo perita peritaje peritas perito
  peritos perjudica perjudicado perjuicio permanencia permanente permisito permitan permitanme permiten permitir
  permito perro persiguen persiguiendo person personal personalizada personalizado personalmente personera personero
  persuasiva persuasivo pertenece peruana peruanas peruano peruanos pesada pesado pescador pescadora pescadoras
  pescadores pesima pesimo peso phishing phone piba pibe pida pidan pide piden pides pidiendo pidiera pidieron pidio
  pido pie piel piensan piensen pierde pierden pierdo pierna pieza pila pilas pilo pilosa piloso piloto pilotos pin
  pintor pintora pintoras pintores piso pke placa placer planilla plateada plateado platica playa plazas pleito pliis
  pliz plomera plomeras plomero plomeros plox pls plz pobre pobres podes podia podian podido podra podran podre
  podremos podriamos policial politica pollo polola pololo pondre pondria ponerle ponerme ponerse ponga pongale pongan
  ponganse pongase poniendo ponle poquita poquitico poquito porahora porcentaje porciento porfavorcito porqe porsiaca
  porsupuesto portafolio portatil portera porteras portero porteros portugues portuguesa portuguesas portugueses pos
  poseedor poseedora posible posiblemente positivo post posta posterior posteriormente pqe pque practicamente
  practicante practicantes preaviso precancelacion preciosa precioso preciosura precisa precisamente precisas preciso
  precisos predio preguntado preguntale preguntan preguntando preguntarle preguntaron preguntarte preguntas pregunte
  preguntele pregunten preguntenle prejuridica prejuridicas prejuridico prejuridicos prenda prendaria prendarias
  prendario prendarios prendida prendido preocupa preocupacion preocupada preocupado preocupe preocupes prepago presa
  presas prescripcion prescrita prescrito presencialidad presencialmente presenta presentador presentadora
  presentadoras presentadores presentar presentarme presente presento presidencia presion presionan presionando
  presionar preso presos prestacion prestamista presupuesto pretty preventiva preventivo previa previo prima primas
  primer primera primeras primero primeros primita primitas primito primitos primo primos principalmente principe
  principio prioritaria prioritario prision privacidad probable probablemente problem procedimiento procurador
  procuradora productor productora productoras productores profesional profesionales programa programada programado
  programador programadora programadoras programadores prohibido promesa prometer prometido prometieron prometio
  prometo promotor promotora promotoras promotores propia propiedad propina propio prorroga proveedor proveedora
  proveedoras proveedores provisional proxima proximas proximo proximos proyecto psicologa psicologas psicologo
  psicologos psiquiatra psiquiatras psst puaj publica publicar publicaron publicidad publico pudiendo pudiera pudieran
  pudieras pudieron pudimos pudiste pue pueblo pueda puedan puertorriquena puertorriquenas puertorriqueno
  puertorriquenos puesto puntaje puntual puntualmente puravida puro purpura puse pusieron puso pyme qubo quebrada
  quebrado quedate queden quedese quehubo quejando quejar quejare quejarme quejaron quejarse quejo querella queres
  querian querias querida querido queriendo querria question quetal quibo quiebra quiera quieran quihubo quince
  quincena quincenal quincenas quindiana quindianas quindiano quindianos quinientos quinta quinto quise quisieran
  quisieras quisiste quiso quita quitar quitaron quiten quitenme quito quiubas quiubo quiubole rabia radicacion
  radicada radicar radio radique raizal raizales random rapida rapidamente rapidas rapidito rapidos rara raro ratico
  ratito rato rayos razon ready reales realizada realizado really realmente rebajar rebajen rebusque recarga recargo
  recaudador recaudadora recaudadoras recaudadores recaudo recepcionista recepcionistas rechazada rechazado rechazan
  rechazar rechazaron rechazo reciba reciban recibia recibida recibido recibiendo recibieron recibimos recibirlo
  recibis recibiste reciclador recicladora recicladoras recicladores recien reciente recientemente recientes reclama
  reclamacion reclaman reclamando reclamar reclame reclusa recluso recolector recolectora recolectoras recolectores
  reconocer reconocimiento reconozco recontra recordado recordamos recordando recordarle recordarme recordaron
  recordatorio recorde rectificacion recuerda recuerdame recuerdan recuerde recuerdeme recuerden recuperada recuperado
  recuperar recurso red reembolsar reembolsen reembolso reenviado reenviar reenvie reenvio reestructuracion
  reestructurada reestructurado refinanciada refinanciado refinanciar refinancien refund regalar regalenme regalo
  regimen region registrada registrado registrador registradora registrarme registre reglamento regresa regresar
  regresaron regrese regreso regulada regulado regular regularmente reintegro relajada relajado relax reliquidacion
  reloj remate remesa remotas remotos rendimiento renegociacion renovacion renta rentabilidad renuncia reorganizacion
  reparacion repartidor repartidora repartidoras repartidores repita repitame reply reporta reportan reportarlo
  reportaron reporten reporto reposicion representacion republica requerimiento reset residencia residencial
  resolucion resolver resolvi resolvio respeta respetada respetado respetame respetamos respetan respetando respetarme
  respetarnos respetaron respetas respeteme respetenme respetes respeto respetuosa respetuosamente respetuoso responda
  respondale respondame respondanle respondanme respondele respondeme respondere responderle responderme responderte
  respondes respondi respondia respondian respondido respondiendo respondieron respondio respondiste responsabilidad
  restaurante resto resuelto resuelva resuelvan resuelve resuelven resuelvo retefuente reteica retencion retira
  retirada retiradas retirado retirados retirar retiren retiro retracto retrasado retraso retuvieron reversion review
  revisada revisado revisalo revisame revisamos revisan revisando revisare revisarlo revisarme revisaron revise
  reviselo reviseme revisenlo revisenme revision revisor revisora revisoras revisores riesgo right robada robado roban
  robando robar robaron robles robo rodilla rojo rollo ropa rosada rosado rota rotativa rotativo roto ruego rumba
  rural rusa rusas ruso rusos ruta sabemos saberlo sabian sabido sabiendo sabra sabre sabria saca sacar sacaron
  sacerdote sacerdotes saco sad salarial salario saldada saldado saldar saldra saldre saldria salga salgan salgo sali
  salia salida salido saliendo salieron salimos salis saluda saludamos saludar saludito saludo salvadorena
  salvadorenas salvadoreno salvadorenos samaria samarias samario samarios sana sanandresana sanandresanas sanandresano
  sanandresanos sancion sancionada sancionado sangre sano saquen saquenme sardina sardinas sardino sardinos sargento
  sargentos sastre sastres satisfecha satisfecho scam score screenshot seca seco sector secuestro secundaria
  secundario sed seg seguia seguida seguido seguimiento seguimos seguis segunda segundito segundos segura seguramente
  seguridad segurisimo seis seiscientos selfie sello semanal semestral semestre senal sencilla sencillo senorito
  senoritos sentencia senti sentido sep sepa sepan separacion septiembre septima septimo sera seran seria serian serie
  serio service servidor servidora servidoras servidores servirle servirte sesenta setecientos setenta setiembre
  seudonimo sexta sexto share shop shopping siente sienten siete siga siglo siguiendo siguiente siguientes siguieron
  siguio silla similar simple simplemente sinceramente sindical sindicalista siniestro sintio sipi sipo siquiera sir
  sirva sirvio sisi sistema site situacion slds soborno sobregiro sobrenombre sobreviviente sociedad sola soldada
  soldadas soldado soldador soldadora soldadoras soldadores soldados soleado solicita solicitada solicitado solicitan
  solicitar solicitaron solicite soliciten solicito solicitud solita solito solucion soluciona solucionado solucionan
  solucionar solucionarlo solucione solucionen soluciono solvencia solvente sono soon soportar soporto sorda sordas
  sordo sordos sori sorpresa sorri sorry spam staff startup status sticker store story suave subasta subieron subir
  subsidio sucede sucedio sucesion sucia sucio suegra suegras suegro suegros sueldo suena sueno suerte suficiente
  sujeto sujetos sumerced superbien superintendencia superior supiera supieron supiste suplantar suplantaron suplente
  suplico supo supongo support supuestamente supuesto sur sure suscriptor suscriptora suscriptoras suscriptores
  suspenda suspendan suspender suspendida suspendido suspendieron suspension susto suya suyo taita taitas talvez
  tantico taquilla tardecita tardia tardio tarea tarjetahabiente tatuador tatuadora tatuadoras tatuadores taxi taxista
  taxistas tbm tbn team techo tecnologa tecnologas tecnologia tecnologo tecnologos tel tele telecobranza
  telefonicamente telefonico telemercadeo teleoperador teleoperadora teleoperadoras teleoperadores teletrabajo
  televentas television televisor tema temperatura temporada temporal tempranito tenaz tendera tenderas tendero
  tenderos tendra tendran tendre tendremos tendria tenedor tenedora tenerlo tenes tenias tenido teniendo tenis
  terapeuta terapeutas terapia tercer tercera terceras tercero terceros tercio terminacion terminado terminal terminan
  terminaron termine termino terreno terrible tesoreria tesoro testamento testigo testigos testimonio testing text
  textear tfno thank thanks that the there this thnx thx tibia tibio ticket tiempo timbra timbran timbrar timbraron
  timbro time tinto tipa tipas tips tirilla titulo tkm tks tlf tmbn tnx toca tocar toco today todita todito todobien
  token tomado tomador tomadora tomando tomaron tomo tomorrow tonight tope toque tormenta tos total totalmente tqm
  trabajaba traduccion traductor traductora traductoras traductores trae traen traer trago traigo trajeron tramitar
  trancon tranqui tranquilicese tranquilidad tranquilizate transferido transferir transferirle transfiera transfieran
  transfiere transfiero transfirio transitoria transitorio transportador transportadoras transportadores transporte
  transversal traslado traspaso trasteo tratamiento tratan trataron traten trato trece treinta tremenda tremendo tren
  tres trescientos tributaria tributarias tributario tributarios tributarista tributo triguena triguenas trigueno
  triguenos trimestral trimestre triste tristeza true tuanis turca turcas turco turcos turno turquesa tusa tutela
  tutor tutora tutoras tutores tuviera tuvieron tuvimos tuviste tuyo uau ubicacion ubicada ubicado ubicar ubico uepa
  uhm uhum uich uish ultima ultimamente ultimas ultimo ultimos umm unica unicamente unico unidad unificacion
  uniformada uniformado uniforme universitaria universitarias universitario universitarios uno update upload
  urbanizacion urgencia urgentemente urgentes url uruguaya uruguayas uruguayo uruguayos usada usado usan usaron user
  username ush uso usualmente usura usurera usurero util utilidad utilizar utilizaron uyuyuy vacaciones vacano vacia
  vacilon vacio vacuna vaina valia valida validado validar validas valide valido validos valio vallenata vallenatas
  vallenato vallenatos vamonos varada varado varias varios vayamos vayan vayas vayase vdd veamos vean vecinita
  vecinito vehicular veia veinte veinticinco veinticuatro veintidos veintinueve veintiocho veintiseis veintisiete
  veintitres veintiuno vejez velorio vemos vence vencer vencida vencidas vencido vencidos vencimiento vencio vendra
  vendre vendria veneca venecas veneco venecos venga vengan veni venia venian venido venimos venis venta ventana
  ventanilla verano verbal verdad verdaderas verdaderos verde vere vereda verguenza veria verifica verificada
  verificado verificame verifican verificando verificarlo verificaron verifique verifiquelo verifiqueme verifiquen
  verla verlo verme verraca verraco verte very vestido vete veterana veteranas veterano veteranos veterinaria
  veterinarias veterinario veterinarios viaje viatico videito video videollamada vides vidita vieja viejas viejita
  viejitas viejito viejitos viejo viejos viendo vienes viento vientos viera vieron vigencia vigente vigentes vigilada
  vigilado vigilante vigilantes vimos vine viniendo viniera vinieron vinotinto violencia virtualidad virus visaje
  visitar visitaron vista viste vive viven viveros vivienda vivir voice volante voluntaria voluntario volver volvera
  volvere volvi volviendo volvieron volvio voucher vuelo vueltas vuelto vuelva vuelvan vuelvas vuelve vuelven vuelvo
  wap wasa wayuu website week weekend welcome wenas wenos wepa wey what when where who why wifi wonderful work worker
  worst wpp wrong xdd xfa xfavor xfi xke xqe xque yamismo yeah year yendo yerno yernos yes yesterday you your yuju yup
  yupi zapato zapatos zona zutana zutano
`;

export const MORE_BRANDS = `
  acer ach acuacar acuavalle acueducto adidas aecsa aerocivil aerolinea aerorepublica afinia afp agaval agencia agua
  aguas ahorro aic airbnb aire aires akt alcaldia alcanos alcantarillado alcatel alfa aliansalud aliexpress allianz
  allus alqueria amarilo amb ambuq amway andes android apple arajet areandina arkitect arl armada aseguradora aseo
  asmet asobancaria asocajas asociacion asofondos assist asus ath audi audifarma auteco aval aviatur avista axa ayco
  bajaj bancafe bancompartir banesco banrep banrepublica bcsc belcorp bellsouth benelli berlinas bershka betplay
  bienestar billetera bimbo binance bitcoin blu bmw bodytech bold bolivariana bolivariano bonnadona booking bpo brahma
  brasilia breb brilla btg byd cabify cable cafesalud cajacopi cajamag cajasai cajasan camacol camara canapro
  cancilleria capresoca cardif cardioinfantil caribe casatoro casur catalogo catastro cedenar celsia celumovil cemex
  cens central cerrejon cesantias challenger changan chec chevrolet chevy chevyplan chubb citroen civica clic clinica
  cmr cofincafe cofrem colcan colfondos colgate colmedica colombina coltefinanciera combarranquilla comcaja comercio
  comertex comfa comfaboy comfaca comfacasanare comfacauca comfacesar comfachoco comfacor comfacundi comfaguajira
  comfahuila comfamiliar comfamiliares comfanorte comfaoriente comfaputumayo comfasucre comfatolima comfiar comisaria
  comparta compensacion conavi concentrix concesionario conconcreto confa confama confamiliar confamiliares confandi
  confenalco congente constructor constructora consumidor consumo contento contraloria contributivo converse convida
  coofinep coofisam coogranada coomotor coomuldesa coopantex cooperativa coopetraban cooprudea coorserpark coosalud
  copa copetran copidrogas coratiendas corbeta corpbanca corporacion corresponsal cosmitet covinoc credencial
  credibanco credifinanciera credinet crediservir cremil croydon cti cun daewoo dafiti davibank decameron defensor
  defensoria dell deprisa despegar dfsk dhl diesel dijin disfarma dispac distoyota distrital dodge dollarcity domina
  dps drummond ducati dusakawi eaab eafit ean easyfly ebsa ecci ecoopsos edatel edeq efigas ejercito electricaribe
  electrificadora electrocaqueta electrohuila electrolux emdecob emdupar emergia empas empopasto emsa emssanar
  emvarias encore enerca energia enertolima eps equidad esp essa estelar eticos euro exequial experian expreso
  externado face famiempresas famisanar fanalca farallones farmacia farmatodo fasecolda fedco fedex fenalcheque
  fenalco fianza fianzacredito fiat fibra fiduagraria fiduciaria fiducolombia fiduprevisora fila finagro finanzas
  fincaraiz finsocial fintech fiscalia flash flota fna fng fogafin fomag fondo fonvivienda fopep foscal fosyga
  fotomulta foton foundever freightliner fundacion funeraria gana gas gases gaula geely gef giros gmac gmail
  gobernacion gobierno granahorrar grancolombiano habi haceb hacienda haval hdi helpharma herbalife hero hipermercado
  hisense honda hospital hotmail huawei hughesnet hyundai ibal icbf icesi icfes ifood igac ikea imbanaco imusa incauca
  incolmotos indrive indriver infinix inmobiliaria inpec inspeccion insta inter interaseo internet interrapidisimo
  invima iphone ips isuzu itm jac jafra javeriana jbl jeep jetsmart judicatura judicial kenworth keralty kia kokoriko
  konecta kredicity ktm kymco laboratorio leasing lenovo ley liberty libre limpia lineru llanogas localiza locatel
  loteria ltda magisterio mallamas mapfre matrix mattelsa mayaguez mazda mcdonalds meddipay mederi medicarte medimas
  medisanitas megabanco megabus megatiendas mensajeros mercacentro mercadopago mercaldas mercamio merqueo messenger
  metlife metro metroagua metrolinea metroplus metrosalud metrotel microcredito microempresas microsoft migracion
  mineducacion minhacienda miniso ministerio minsalud mintic mintrabajo mintransporte minvivienda mio mitsubishi
  moneygram moneyman motorola movilidad mundial mutual nike nissan nokia notaria novaventa offimedicas ola omnilife
  oppo optica orbitel oriflame oster ostu outlook outsourcing pacifika pactual pagaduria pagatodo panamericana
  panasonic patprimo paypal payu pedagogica pension personeria pibank picap pijaos pilatos pluxee politecnico ponal
  popular positiva powwi predial prepagada prever previsora procredit procuraduria prodesa profamilia promoambiental
  prosperidad proteccion puma puntored quala qualitas rama rapicredit rappicard rci realme rebaja redeban reebok
  refinancia registraduria renting riopaila runt rushbet saferbo saludcoop saludvida samsung sao sapiencia sas satena
  savia sbs servibanca servientrega sfc shaio shein sic sijin simit sindicato sisben sistemcobro sitel sitp skandia
  skechers smartfit sodexo sofasa solidaria solsalud solventa somer sos starker starlink stradivarius studio subred
  subsidiado sufi superfinanciera supergiros superindustria superinter supernotariado supersalud superservicios
  supersociedades supersolidaria supersubsidio supertransporte suramericana sured surtigas synlab tala tcc tcl tecno
  tecnologico tecnomecanica tecnoquimicas telebucaramanga telecom telefonia telefonica teleperformance telmex temu
  tennis tequendama terramar tigoune toshiba tostao toyota tpaga transcaribe transfiya transipiales transmetro
  transmilenio transportadora tribunal triple truecaller tugo tullave tupperware tvs twitter uala uao uariv uber ucc
  udea udenar udistrital ugpp uis umco unab unad unal uniajc uniandes uniatlantico unicatolica unicauca unilever
  unilibre uniminuto uninorte unique unisabana univalle upb uptc urosario usco usta utp utrahuilca valorizacion vans
  vaquita velotax veolia versalles vespa virgin virrey viva vivaair vivo volkswagen volvo western whatsap whirlpool
  wingo wompi wplay xiaomi yadinero yahoo yamaha youtube zenu zinobe zte zurich
`;

export const MORE_FIRST_NAMES = `
  abdon abelardo abelino abigail abner abrahan abril absalon ada adalberto adela adelaida adelina adelmo adonis
  adriano agapito agripina agueda aicardo aitana alcibiades alcira aldo alegria alejandrina alejo alina allison
  alondra altagracia amada amadeo amado amancio ambar ambrosio americo amilcar aminta anabel anacleto anais anastasia
  anastasio ancizar andrey andy angeles angelina anny anselmo antonella anyela apolinar apolonio aquiles aracely
  arcadio arcangel arcesio argelia argiro ariadna aristoteles arlex arnobis arnoldo arquimedes arsenio artemio
  ascension asdrubal ashley atanasio aurelia auxiliadora avelino axel azucena baldomero baltasar barbara bartolo
  bartolome basilio bautista belarmino belisario belkis benedicto benigno benilda benito berenice bernabe bernarda
  bernardino betsy bibiana bienvenido bladimir blas bonifacio brallan braulio breiner brian brigida brisa bruno byron
  calixto camelia candela candelaria candelario candida candido carlota carmela carmelo carmenza carmina carola
  casimiro catherine cayetano ceferino celestina celestino celina celmira celso cinthia cintia cipriano clarisa
  claudio clemencia clotilde constantino coral cornelio cosme crisanto crisostomo cristal cruz daisy dalila dana danna
  danny dany darling dayron debora deimer deiver deivis delfina delia delio demetrio denise desiderio deyber diamante
  dina diogenes diomedes dionisio dioselina dolly dominga donaldo donato dumar edelberto edelmiro ederson edna eduar
  eladio elba elber elcy eleazar eleuterio elian elida elio elmer eloisa eloy elsy elver elvia elvis emerita emigdio
  emilce emilse emily emir encarnacion ender enith enoc epifania epifanio erasmo erney ervin erwin esau esmeralda
  esneda esneyder estanislao estefany etelvina euclides eudoro eulalia eunice eusebio evangelina evaristo evelin
  everardo facundo fatima faustino fausto feliciano felisa felix fermin fernan filiberto filomena floralba florencio
  florentino fortuna fortunato francia francisca frank froilan fulgencio gabino gaspar gema genaro genoveva geovanni
  geovanny geronimo ginna giovani giselle godofredo gregoria griselda guido gumersindo hanna harol harrison hasbleidy
  heliodoro hellen helmer heraclio herminio hermogenes herney hilario hipolito holman homero honorio hortensia ian
  iker ildefonso ilse imelda inmaculada inocencio irma isaura isidoro isidro ismenia jacinta jacinto jackeline jackson
  jacob jade janet jean jeremias jerson jhonathan joan jonatan josefa joselyn judy julieth justina justiniano justino
  justo juvenal karla katerin katia keyla ladislao laureano lazaro leidi leila leoncio leonilde leonor leopoldo leslie
  lesly leydy lia liam liberato libertad lida lidia lila liliam lilian lily lino lisandro lisbeth lizbeth lluvia luca
  lucelly lucero lucila lucio lucrecia ludwig ludwing luna mabel macarena macario magali magaly magda magnolia magola
  maikol mar marcelino marcelo margoth marianela mariano maricela mariluz marilyn marino marisela marjorie marlen
  marlene martina mary maryluz maryory matilde maycol melida melisa melquiades michelle milciades mildred mileidy
  minerva mireya mirian mirna miryam modesta modesto montserrat nadia napoleon narciso nasly natanael nathaly
  natividad nayibe nazario nelida nelsy nepomuceno nereida nhora nicanor nicole nilson noe noel noelia nohemi nora
  norbey nury obdulia odalis odalys olegario olimpo olivia onofre oriana otilia otoniel paloma pamela pastora paulino
  paulo petrona placido plinio policarpo porfirio primitivo priscila prospero prudencia prudencio purificacion quintin
  radamel rafaela raimundo ramona remigio renata renato richard rita roger romelia romina romualdo romulo ronald roque
  rosalia rosana rosangela rosaura rosiris rosmery rosmira roxana rubi ruby rufino rusbel sabina sabino salomon
  samanta samantha samir santos saturnino selena selene serafin serafina serena servando severino severo silvana
  silverio silvestre sirley sixto snaider sneyder socrates stefania stephany tadeo telesforo temistocles teodora
  thalia tiberio timoteo tito tomasa toribio tranquilino transito tulio ubaldina ubaldo ursula valentino valerio
  venancio ventura vicenta victoriano victorino vidal vilma violeta virgelina virgilio virginia vivian vladimir walter
  wenceslao wilfrido willington winston yadira yair yamileth yanira yaritza yasmin yecid yennifer yineth yira yohan
  yordan yorlady yorleny yoselin yudy yuliet zacarias zenon zharick zulay zuleima
`;

export const MORE_WORD_NAMES = `
  abril alegria amada amado ambar angeles arcangel ascension auxiliadora azucena bautista benigno bienvenido brisa
  camelia candela candida candido clemencia coral cristal diamante encarnacion esmeralda fortuna fortunato francia
  gema hortensia inmaculada jade jean libertad lila lino lluvia lucero luna magnolia marino modesta natividad paloma
  pastora placido primitivo prospero prudencia purificacion rubi santos serena severo transito ventura violeta
`;

export const MORE_SURNAMES = `
  abad abadia abello abril acero acuna adarve advincula afanador agamez agualimpia aguilar aguilera ahumada alba
  alcala alcazar aldana alean alegria alfaro almanza almario almeida almonacid alonso altamar altamira altamiranda
  alvear alvira alvis amariles amaris amell amezquita amortegui ampudia anacona anchico angarita anzola aparicio
  apraez aragon arana araujo arbelaez arce archila arcila arciniegas arcos argel argote arguello argumedo aristizabal
  ariza arizala arizmendi armenta armero aroca arrazola arroyo arrubla arteaga artunduaga arzuaga ascanio asprilla
  atehortua atencia avella avellaneda avendano ayala ayerbe azcarate bacca badillo baez bahamon balaguera balanta
  balcazar baldovino ballen ballestas ballesteros banguera banguero banol banquez baracaldo barahona barajas barboza
  barco baron barragan barraza barreiro barrero barrientos barros bastidas bastos bautista bayona bejarano belalcazar
  beleno benavidez benedetti benjumea berdugo bermeo bermon berrio berrocal bertel betin biojo blanquicet bobadilla
  bocanegra bohorquez bolano bolanos bonett bonfante bonivento borda borrero bossa botello botia botina briceno brito
  brochero buelvas buenahora builes bula burbano bustillo caamano cabarcas cabezas cabra cabrales caceres cadavid
  cadena cajiao calambas calero callejas calvache calvete camargo cambindo camelo campillo campuzano canas canaveral
  canchila candela canizales canon cantillo cantor capacho capera carabali caraballo caravali carbonell cardoso
  cardozo carpio carranza carrasco carrasquilla carrero carriazo carrion casadiego casallas casanova casierra cassiani
  castellar castiblanco catano cavadia cediel celedon cendales cepeda ceron cerpa cerquera cervantes cetina chalarca
  chamorro chara charris charry chaux chavarria chavarro chaverra chaves chica chilito chinchilla chiquillo chunza
  cisneros cleves cobo cobos coello collazos colmenares conde coneo consuegra copete coral corena coronel coronell
  corpas corrales correal corzo cossio cote cotes criollo cristancho cuadrado cuadros cubides cubillos cuello cuenca
  cuero cuetia cuevas culma cundumi dagua dajome dangond davila delgadillo deluque dimate donado dorado doria duenas
  dulcey duran durango dussan ebratt echandia echavarria echeverria elejalde elles enciso enriquez eraso erazo
  escalona escamilla escandon escarria escorcia espana espinal espinel esquivel estacio estevez estupinan fabregas
  falla fandino farah ferreira ferrer ferro fierro figueredo fino florian fonnegra fontalvo fragozo freyle frias
  fuquen fuquene gacha galan galarza gallardo galvan galvez gamarra ganan gaona garavito garay garizabalo garnica
  garrido gelves gelvez gnecco godoy goenaga gongora gonzales gordillo goyeneche gracia graciano grajales grisales
  grueso gruezo guacaneme gualdron gualteros guapacha guaqueta guarnizo guette guio guisao herazo heredia hermida
  herran herreno herrero hidalgo higuera hinestroza hinojosa hortua humanez ibanez ibarguen idarraga iguaran illera
  imbachi infante insignares insuasty iragorri iriarte jacome jaimes jaraba jojoa joya julio labrador lacouture ladino
  lafaurie lagos laguado lambrano lamprea lamus lancheros landazabal landazuri largacha largo larrahondo larranaga
  larrota lasprilla latorre lebrija ledezma lemos lemus lerma lesmes leyton leyva lezama lievano lindarte lindo
  lizcano llanos lleras llerena llinas lloreda llorente lobelo lombo loperena lora lorduy losada lozada lucero luengas
  lujan luque macea macias madariaga madero madrigal maestre mafla mahecha malaga malagon malaver mallarino mancera
  mancilla mancipe mangones manjarres manotas manzano marimon marino marmolejo marriaga marroquin marrugo martelo
  mateus matiz maturana maya mayo mayorga mazuera melendez melgar melgarejo mendieta mendivelso mengual merchan merino
  mesias mestra milanes millan mina mindiola mira mogollon molano molinares molinero moncada moncayo mondragon
  montalvo montana montanez morantes morelo moscote motato motta moya moyano mueses mujica munar muneton munive murcia
  murgas mutis najar nanez navarra navarrete navas negrete nieves noriega nossa obregon ocana ocoro ojeda olarte olave
  olivella olivero oliveros olivo onate oquendo orduz orejuela orjuela orobio ortegon ospino otalora otero oviedo
  oyola pachon paez pajaro palencia palma palomeque pamplona panameno panesso paniagua paramo pastrana paternina pava
  payares pedraza pedroza pedrozo penalosa penaranda penata penuela peralta perilla pertuz pescador pestana petro
  picon piedrahita pimienta pinchao pinedo pinilla piraquive pitalua pizano pizarro plaza plazas polanco polania pombo
  ponce ponton portela portilla porto portocarrero poveda prada preciado pretelt puche puello puerto pulgarin pumarejo
  puyana quejada quesada quigua quijano quimbayo quinonez quitian rada raigosa rangel rativa rave rebolledo redondo
  reina remolina rengifo revelo riano riascos ricaurte ripoll roa robayo robles roca rodallega rodelo rojano rolon
  rolong roman romana roncancio rovira rua rubiano saa sabogal sahagun saldana saldarriaga samboni sampayo sanguino
  sanjuan santacruz santiago santofimio sanz sarria sastoque sayago segovia segura serpa sevillano simanca simancas
  sinisterra solarte soler solis solorzano soria sosa sotomayor suaza suescun taborda tangarife tapasco tapia tapiero
  tascon teheran tello tenorio theran tibaduiza tibocha timana tobar tolosa toncel torrado torregrosa trejos trivino
  trochez tuberquia tuiran turbay ucros ugarte umana unigarro urango urbina urdaneta urquijo urrutia uruena urueta
  usma ustariz vaca vahos valdelamar valdez valdivia valdivieso valero vallecilla valoyes valverde vazquez velazquez
  venegas ventura vergel viafara viancha vides villabona villadiego villafane villalobos villamarin villanueva
  villaquiran villar villareal villarraga villazon viloria vinasco vivas viveros vives vizcaino wilches yarce yaruro
  yate yela yepez yule zabaleta zafra zamudio zaragoza zarama zorro zuleta zuniga
`;
