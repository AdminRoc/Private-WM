(function () {
  var form = document.getElementById('bw-login-form');
  var btn = document.getElementById('bw-login-btn');
  var errEl = document.getElementById('bw-login-err');

  function showError(msg) {
    errEl.textContent = msg;
    errEl.classList.add('show');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errEl.classList.remove('show');
    btn.disabled = true;
    btn.textContent = '登录中…';

    var email = document.getElementById('bw-email').value;
    var password = document.getElementById('bw-pass').value;

    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: email, password: password }),
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, body: j }; });
    }).then(function (res) {
      if (!res.ok) {
        showError((res.body && res.body.error) || '登录失败，请重试。');
        btn.disabled = false;
        btn.textContent = '登录';
        return;
      }
      location.href = 'index.html';
    }).catch(function () {
      showError('网络异常，请重试。');
      btn.disabled = false;
      btn.textContent = '登录';
    });
  });
})();
