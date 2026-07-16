import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmvco, extractBrebKey, decodeBrebString } from '../src/breb-qr.js';

// Strings EMVCo REALES decodificados de los 2 QR de Jhon Fredy (jun-2026).
// QR 2: llave alfanumérica @jhon437203 (tag 26.04).
const QR_LLAVE = '00020101021126330014CO.COM.RBM.LLA0411@jhon43720349250014CO.COM.RBM.RED0103RBM50290013CO.COM.RBM.CU01080000000051220013CO.COM.RBM.CA010105204000053031705802CO59010600106101062270710CC80144372080200110363180270016CO.COM.RBM.CANAL0103APP81250015CO.COM.RBM.CIVA01020282260014CO.COM.RBM.IVA01040.0083270015CO.COM.RBM.BASE01040.0084250015CO.COM.RBM.CINC01020285260014CO.COM.RBM.INC01040.0090430016CO.COM.RBM.TRXID0119000001Hnc8F81-4FW2h91460014CO.COM.RBM.SEC0124nW2B7BvQjf1jRoD475BbyCSs6304086E';

// QR 1: por cuenta/numérica (tag 26.05 = "353497", cuenta en 50.01), nombre comercio.
const QR_CUENTA = '00020101021126320014CO.COM.RBM.LLA0510002935349749250014CO.COM.RBM.RED0103RBM50310013CO.COM.RBM.CU011000293534975204000053031705502015802CO5922Supermercado pa mi gen600511001610511001622703030000703000080200110363180270016CO.COM.RBM.CANAL0103APP81250015CO.COM.RBM.CIVA01020182260014CO.COM.RBM.IVA01040.0083270015CO.COM.RBM.BASE01040.0084250015CO.COM.RBM.CINC01020185260014CO.COM.RBM.INC01040.0090430016CO.COM.RBM.TRXID0119000001I6ayJyyIOS_bD91460014CO.COM.RBM.SEC0124eFE7uHXU4FwbxK6MRAnHbf94630487B9';

describe('parseEmvco (TLV)', () => {
  test('parsea tags de primer nivel', () => {
    const tlv = parseEmvco(QR_LLAVE);
    assert.equal(tlv['00'], '01');           // payload format
    assert.equal(tlv['49'].children['01'], 'RBM'); // red Bre-B
  });

  test('tag 26 es un template con la info de la llave', () => {
    const tlv = parseEmvco(QR_LLAVE);
    assert.ok(tlv['26'].children);
    assert.equal(tlv['26'].children['00'], 'CO.COM.RBM.LLA');
    assert.equal(tlv['26'].children['04'], '@jhon437203');
  });

  test('extrae el nombre del comercio (tag 59)', () => {
    const tlv = parseEmvco(QR_CUENTA);
    assert.equal(tlv['59'], 'Supermercado pa mi gen');
  });
});

describe('extractBrebKey', () => {
  test('QR con llave alfanumérica → @jhon437203, ruteable', () => {
    const r = extractBrebKey(QR_LLAVE);
    assert.equal(r.key, '@jhon437203');
    assert.equal(r.keyType, 'alias');
    assert.equal(r.routable, true);
    assert.equal(r.merchantName, '0'); // este QR trae "0" como nombre
  });

  test('QR con llave numérica → 0029353497, ruteable (Bancolombia la rotula "Llave")', () => {
    const r = extractBrebKey(QR_CUENTA);
    assert.equal(r.key, '0029353497');
    assert.equal(r.keyType, 'numerica');
    assert.equal(r.routable, true);
    assert.equal(r.merchantName, 'Supermercado pa mi gen');
  });

  test('QR con llave de CELULAR (tag 26.02) → rutea', () => {
    // string EMVCo real del 3er QR de Jhon: 26.02 = "3134029429" (celular)
    const QR_CEL = '00020101021126320014CO.COM.RBM.LLA0210313402942949250014CO.COM.RBM.RED0103RBM50130013CO.COM.RBM.CU0108000000005204000053031705802CO59010600106101063040000';
    const r = extractBrebKey(QR_CEL);
    assert.equal(r.key, '3134029429');
    assert.equal(r.routable, true);
  });

  test('string sin tag 26 → null', () => {
    assert.equal(extractBrebKey('00020101'), null);
  });

  test('variante nueva SIN tag 26: llave en tag 50 namespace CU (orden 434c25cd, jul-2026)', () => {
    // String EMVCo real del QR de "Como en Casa" (Bancolombia rotula "Llave: 0090387471").
    const QR_SIN_26 = '0002015502010102115802CO5912Como en Casa49250103RBM0014CO.COM.RBM.RED903001060000010016CO.COM.RBM.TRXID80270103APP0016CO.COM.RBM.CANAL91460124uDgCGXcFtnLy/vw8VJrCpwKZ0014CO.COM.RBM.SEC81250102010015CO.COM.RBM.CIVA601211001 BOGOTA8223010100014CO.COM.RBM.IVA5031011000903874710013CO.COM.RBM.CU6105110018324010100015CO.COM.RBM.BASE624602103046481003030300007030000802000901A110363184250102010015CO.COM.RBM.CINC520400008523010100014CO.COM.RBM.INC530317064220002ES0112Como en Casa63040377';
    const r = extractBrebKey(QR_SIN_26);
    assert.equal(r.key, '0090387471');
    assert.equal(r.keyType, 'numerica');
    assert.equal(r.routable, true);
    assert.equal(r.merchantName, 'Como en Casa');
  });
});

describe('decodeBrebString', () => {
  test('devuelve key + raw + tlv para regenerar', () => {
    const r = decodeBrebString(QR_LLAVE);
    assert.equal(r.key, '@jhon437203');
    assert.equal(r.raw, QR_LLAVE);
    assert.ok(r.tlv['26']);
  });

  test('string ilegible → null', () => {
    assert.equal(decodeBrebString('basura'), null);
  });
});
