const mobileButton = document.querySelector('.mobile-menu');
const nav = document.querySelector('.main-nav');

if (mobileButton && nav) {
  mobileButton.addEventListener('click', () => {
    nav.classList.toggle('open');
  });
}
