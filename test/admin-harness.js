// Stubbed IAM for admin-harness.html: three roles, one user on one of them.
(async function () {
  'use strict';
  const out = document.getElementById('out');
  let fails = 0;
  const check = (name, ok) => { if (!ok) fails++; out.textContent += (ok ? 'pass  ' : 'FAIL  ') + name + '\n'; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms || 120));

  const ROLES = [
    { id: 'recOPS', fields: { 'Role Name': 'Operations Manager', Active: true } },
    { id: 'recEXP', fields: { 'Role Name': 'Expense Verifier', Active: true } },
    { id: 'recOLD', fields: { 'Role Name': 'Old role', Active: false } },
  ];
  const USERS = [{ id: 'recMELANIE', fields: { 'Full Name': 'Melanie', Email: 'melanie@x', Status: 'Active', 'Access Level': ['recOPS'] } }];
  const UPDATES = [];
  TX.me = () => ({ email: 'raymond@x', role: { canManageUsers: true } });
  TX.list = async (base, table) => ({ records: table === 'users' ? JSON.parse(JSON.stringify(USERS)) : table === 'access_levels' ? ROLES : [] });
  TX.update = async (base, table, id, fields) => {
    UPDATES.push({ table, id, fields });
    Object.assign(USERS.find((u) => u.id === id).fields, fields);
    return { id, fields };
  };

  TX.emit('auth:ready');
  await wait();
  document.getElementById('btnAdmin').click();
  await wait(300);
  check('the user list shows the role', /Operations Manager/.test(document.getElementById('uList').textContent));
  document.querySelector('#uList [data-act="edit"]').click();
  await wait(300);
  const boxes = [...document.querySelectorAll('#dRoles input')];
  check('every active role can be ticked; an inactive one is not offered', boxes.map((b) => b.value).join() === 'recOPS,recEXP');
  check('the current role is ticked', boxes.find((b) => b.value === 'recOPS').checked && !boxes.find((b) => b.value === 'recEXP').checked);
  boxes.find((b) => b.value === 'recEXP').checked = true;
  document.getElementById('dSave').click();
  await wait(300);
  const u = UPDATES.pop();
  check('saving sends both roles', u && u.fields['Access Level'].join() === 'recOPS,recEXP');
  document.getElementById('uBack').click();
  await wait(300);
  check('and the list names both', /Operations Manager \+ Expense Verifier/.test(document.getElementById('uList').textContent));
  document.querySelector('#uList [data-act="edit"]').click();
  await wait(300);
  document.querySelectorAll('#dRoles input').forEach((b) => { b.checked = false; });
  const before = UPDATES.length;
  document.getElementById('dSave').click();
  await wait(200);
  check('a user cannot be saved with no role', UPDATES.length === before && /at least one/.test(document.getElementById('uMsg').textContent));

  document.title = 'Admin harness — ' + (fails ? 'FAIL' : 'PASS');
  out.textContent += fails ? fails + ' failed\n' : 'PASS (0 failed)\n';
})();
