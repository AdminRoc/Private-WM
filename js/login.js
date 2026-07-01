(function () {
  /* ── 星空背景 ── */
  (function initStars() {
    var c = document.getElementById('star-canvas');
    if (!c || !c.getContext) return;
    var ctx = c.getContext('2d'), stars = [], shootingStars = [];

    function resize() {
      c.width = window.innerWidth; c.height = window.innerHeight; stars = [];
      var n = Math.floor(c.width * c.height / 7000);
      for (var i = 0; i < n; i++)
        stars.push({
          x: Math.random() * c.width, y: Math.random() * c.height,
          r: Math.random() * 1.4 + 0.2,
          a: Math.random() * 0.7 + 0.2,
          da: (Math.random() - 0.5) * 0.006,
        });
    }

    function addShootingStar() {
      if (Math.random() > 0.015) return;
      shootingStars.push({
        x: Math.random() * c.width * 0.7,
        y: Math.random() * c.height * 0.4,
        len: Math.random() * 120 + 60,
        speed: Math.random() * 6 + 4,
        angle: Math.PI / 5 + Math.random() * 0.3,
        life: 1,
      });
    }

    function draw() {
      ctx.clearRect(0, 0, c.width, c.height);
      // 星星
      stars.forEach(function (s) {
        s.a += s.da;
        if (s.a > 0.9 || s.a < 0.1) s.da *= -1;
        ctx.globalAlpha = s.a;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      });
      // 流星
      addShootingStar();
      shootingStars = shootingStars.filter(function (ss) {
        ss.life -= 0.03;
        if (ss.life <= 0) return false;
        var dx = Math.cos(ss.angle) * ss.speed;
        var dy = Math.sin(ss.angle) * ss.speed;
        var grad = ctx.createLinearGradient(ss.x, ss.y, ss.x - dx * ss.len / ss.speed, ss.y - dy * ss.len / ss.speed);
        grad.addColorStop(0, 'rgba(212,168,74,' + ss.life * 0.9 + ')');
        grad.addColorStop(1, 'rgba(212,168,74,0)');
        ctx.globalAlpha = ss.life;
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(ss.x, ss.y);
        ctx.lineTo(ss.x - dx * ss.len / ss.speed, ss.y - dy * ss.len / ss.speed);
        ctx.stroke();
        ss.x += dx; ss.y += dy;
        return true;
      });
      ctx.globalAlpha = 1;
      requestAnimationFrame(draw);
    }

    window.addEventListener('resize', function () { resize(); });
    resize(); draw();
  })();

  /* ── 登录逻辑 ── */
  var form  = document.getElementById('bw-login-form');
  var btn   = document.getElementById('bw-login-btn');
  var errEl = document.getElementById('bw-login-err');

  function showError(msg) {
    errEl.textContent = msg;
    errEl.classList.add('show');
    errEl.classList.remove('bw-login-err--hide');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errEl.classList.remove('show');
    btn.disabled = true;
    btn.textContent = '验证中…';

    var email    = document.getElementById('bw-email').value.trim();
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
        btn.disabled = false; btn.textContent = '登录';
        return;
      }
      btn.textContent = '✓ 验证通过';
      setTimeout(function () { location.href = 'index.html'; }, 420);
    }).catch(function () {
      showError('网络异常，请重试。');
      btn.disabled = false; btn.textContent = '登录';
    });
  });
})();
