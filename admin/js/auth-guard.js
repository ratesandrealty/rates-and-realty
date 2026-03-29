(function() {
  const isAuthenticated = localStorage.getItem('rr_admin_auth') === 'authenticated_2024';
  if (!isAuthenticated) {
    const currentPage = encodeURIComponent(window.location.pathname);
    window.location.replace('/auth/admin-login.html?redirect=' + currentPage);
  }
})();

function adminLogout() {
  localStorage.removeItem('rr_admin_auth');
  window.location.href = '/auth/admin-login.html';
}
