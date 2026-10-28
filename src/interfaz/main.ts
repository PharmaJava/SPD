import { mount } from 'svelte';
import './estilos/base.css';
import './api.ts';
import App from './App.svelte';

mount(App, { target: document.getElementById('app')! });
