/** ISO 3166-1 alpha-2 code, English name, main news language (ISO 639-1). Used to rotate world-wide source discovery. */
export interface WorldCountry {
  code: string;
  name: string;
  lang: string;
  /** 1 = covered first (large media markets, neighbours of Ukraine, major partners); 3 = last. */
  priority: 1 | 2 | 3;
}

const RAW = `
UA:Ukraine:uk:1,US:United States:en:1,GB:United Kingdom:en:1,DE:Germany:de:1,FR:France:fr:1,PL:Poland:pl:1,IT:Italy:it:1,ES:Spain:es:1,
CA:Canada:en:1,JP:Japan:ja:1,KR:South Korea:ko:1,CN:China:zh:1,IN:India:en:1,TR:Turkey:tr:1,IL:Israel:he:1,BR:Brazil:pt:1,
AU:Australia:en:1,NL:Netherlands:nl:1,SE:Sweden:sv:1,NO:Norway:no:1,FI:Finland:fi:1,DK:Denmark:da:1,CZ:Czechia:cs:1,SK:Slovakia:sk:1,
RO:Romania:ro:1,MD:Moldova:ro:1,LT:Lithuania:lt:1,LV:Latvia:lv:1,EE:Estonia:et:1,HU:Hungary:hu:1,BG:Bulgaria:bg:1,GE:Georgia:ka:1,
RU:Russia:ru:1,BY:Belarus:be:1,AT:Austria:de:2,CH:Switzerland:de:2,BE:Belgium:nl:2,IE:Ireland:en:2,PT:Portugal:pt:2,GR:Greece:el:2,
HR:Croatia:hr:2,RS:Serbia:sr:2,SI:Slovenia:sl:2,BA:Bosnia and Herzegovina:bs:2,AL:Albania:sq:2,MK:North Macedonia:mk:2,ME:Montenegro:sr:2,
XK:Kosovo:sq:2,AM:Armenia:hy:2,AZ:Azerbaijan:az:2,KZ:Kazakhstan:ru:2,UZ:Uzbekistan:uz:2,SA:Saudi Arabia:ar:2,AE:United Arab Emirates:ar:2,
QA:Qatar:ar:2,EG:Egypt:ar:2,IR:Iran:fa:2,IQ:Iraq:ar:2,JO:Jordan:ar:2,LB:Lebanon:ar:2,SY:Syria:ar:2,PK:Pakistan:ur:2,BD:Bangladesh:bn:2,
ID:Indonesia:id:2,MY:Malaysia:ms:2,SG:Singapore:en:2,TH:Thailand:th:2,VN:Vietnam:vi:2,PH:Philippines:en:2,TW:Taiwan:zh:2,HK:Hong Kong:zh:2,
NZ:New Zealand:en:2,MX:Mexico:es:2,AR:Argentina:es:2,CL:Chile:es:2,CO:Colombia:es:2,PE:Peru:es:2,VE:Venezuela:es:2,ZA:South Africa:en:2,
NG:Nigeria:en:2,KE:Kenya:en:2,ET:Ethiopia:am:2,MA:Morocco:ar:2,DZ:Algeria:ar:2,TN:Tunisia:ar:2,GH:Ghana:en:2,
IS:Iceland:is:3,LU:Luxembourg:fr:3,MT:Malta:en:3,CY:Cyprus:el:3,LI:Liechtenstein:de:3,MC:Monaco:fr:3,AD:Andorra:ca:3,SM:San Marino:it:3,
KG:Kyrgyzstan:ky:3,TJ:Tajikistan:tg:3,TM:Turkmenistan:tk:3,MN:Mongolia:mn:3,AF:Afghanistan:fa:3,NP:Nepal:ne:3,LK:Sri Lanka:si:3,MM:Myanmar:my:3,
KH:Cambodia:km:3,LA:Laos:lo:3,BN:Brunei:ms:3,KP:North Korea:ko:3,KW:Kuwait:ar:3,BH:Bahrain:ar:3,OM:Oman:ar:3,YE:Yemen:ar:3,PS:Palestine:ar:3,
LY:Libya:ar:3,SD:Sudan:ar:3,SS:South Sudan:en:3,SO:Somalia:so:3,DJ:Djibouti:fr:3,ER:Eritrea:ti:3,UG:Uganda:en:3,TZ:Tanzania:sw:3,RW:Rwanda:rw:3,
BI:Burundi:fr:3,CD:DR Congo:fr:3,CG:Republic of the Congo:fr:3,GA:Gabon:fr:3,CM:Cameroon:fr:3,CF:Central African Republic:fr:3,TD:Chad:fr:3,
NE:Niger:fr:3,ML:Mali:fr:3,BF:Burkina Faso:fr:3,SN:Senegal:fr:3,GM:Gambia:en:3,GN:Guinea:fr:3,GW:Guinea-Bissau:pt:3,SL:Sierra Leone:en:3,
LR:Liberia:en:3,CI:Ivory Coast:fr:3,TG:Togo:fr:3,BJ:Benin:fr:3,MR:Mauritania:ar:3,CV:Cape Verde:pt:3,ST:Sao Tome and Principe:pt:3,GQ:Equatorial Guinea:es:3,
AO:Angola:pt:3,ZM:Zambia:en:3,ZW:Zimbabwe:en:3,MW:Malawi:en:3,MZ:Mozambique:pt:3,BW:Botswana:en:3,NA:Namibia:en:3,LS:Lesotho:en:3,SZ:Eswatini:en:3,
MG:Madagascar:fr:3,MU:Mauritius:en:3,SC:Seychelles:en:3,KM:Comoros:fr:3,
CU:Cuba:es:3,DO:Dominican Republic:es:3,HT:Haiti:fr:3,JM:Jamaica:en:3,TT:Trinidad and Tobago:en:3,BS:Bahamas:en:3,BB:Barbados:en:3,
GT:Guatemala:es:3,HN:Honduras:es:3,SV:El Salvador:es:3,NI:Nicaragua:es:3,CR:Costa Rica:es:3,PA:Panama:es:3,BZ:Belize:en:3,
EC:Ecuador:es:3,BO:Bolivia:es:3,PY:Paraguay:es:3,UY:Uruguay:es:3,GY:Guyana:en:3,SR:Suriname:nl:3,
PG:Papua New Guinea:en:3,FJ:Fiji:en:3,WS:Samoa:en:3,TO:Tonga:en:3,VU:Vanuatu:en:3,SB:Solomon Islands:en:3,
`;

export const WORLD_COUNTRIES: WorldCountry[] = RAW.split(',')
  .map((x) => x.trim())
  .filter(Boolean)
  .map((entry) => {
    const [code, name, lang, pr] = entry.split(':');
    return { code, name, lang, priority: Number(pr) as 1 | 2 | 3 };
  });
