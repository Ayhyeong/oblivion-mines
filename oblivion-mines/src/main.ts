import './styles.css';
import { mount } from './ui/app';

const root = document.getElementById('app');
if (!root) throw new Error('#app 을 찾지 못했습니다.');
mount(root);
