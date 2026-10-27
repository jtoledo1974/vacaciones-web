'use client';

type FirebaseConfiguration = { projectId: string; apiKey: string; authDomain: string; appId?: string };
type FirebaseUser = { uid: string; email: string | null; getIdToken: (forceRefresh?: boolean) => Promise<string> };
type AuthInstance = {
  currentUser: FirebaseUser | null;
  onIdTokenChanged: (callback: (user: FirebaseUser | null) => void) => () => void;
  signInWithPopup: (provider: unknown) => Promise<unknown>;
  signOut: () => Promise<void>;
};
type FirebaseCompat = {
  apps: unknown[];
  initializeApp: (configuration: FirebaseConfiguration) => unknown;
  auth: {
    (app?: unknown): AuthInstance;
    GoogleAuthProvider: new () => unknown;
  };
};
import { apiFetch } from './api-client.ts';

declare global {
  interface Window {
    firebase?: FirebaseCompat;
  }
}

const SDK = '11.10.0';
let auth: AuthInstance | null = null;
let loaded: Promise<boolean> | null = null;
const watchers = new Set<() => void>();
let unsub: (() => void) | null = null;
function publish() {
  for (const watcher of watchers) watcher();
}
function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.crossOrigin = 'anonymous';
    const timeout = setTimeout(() => {
      script.remove();
      reject(new Error('Firebase no se ha podido cargar'));
    }, 12000);
    script.onload = () => {
      clearTimeout(timeout);
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('No se ha podido cargar Firebase desde Google'));
    };
    document.head.appendChild(script);
  });
}

/** Initialise optional Firebase authentication. With no config, Sites authentication is untouched. */
export function initialiseFirebase(): Promise<boolean> {
  if (loaded) return loaded;
  loaded = (async () => {
    const response = await apiFetch('auth-config', { auth: false });
    if (!response.ok) return false;
    const config = ((await response.json()) as { firebase: FirebaseConfiguration | null }).firebase;
    if (!config) return false;
    await loadScript('https://www.gstatic.com/firebasejs/' + SDK + '/firebase-app-compat.js');
    await loadScript('https://www.gstatic.com/firebasejs/' + SDK + '/firebase-auth-compat.js');
    const firebase = window.firebase;
    if (!firebase) throw new Error('Firebase Auth no está disponible');
    if (!firebase.apps.length) firebase.initializeApp(config);
    auth = firebase.auth();
    unsub = auth.onIdTokenChanged(() => publish());
    return true;
  })().catch((error) => {
    loaded = null;
    throw error;
  });
  return loaded;
}
export function subscribeFirebaseSession(callback: () => void): () => void {
  watchers.add(callback);
  return () => {
    watchers.delete(callback);
  };
}
export function firebaseUser(): FirebaseUser | null {
  return auth?.currentUser ?? null;
}
export async function firebaseBearerToken(): Promise<string | null> {
  return auth?.currentUser ? auth.currentUser.getIdToken() : null;
}
export async function firebaseSignInWithGoogle(): Promise<void> {
  if (!(await initialiseFirebase()) || !auth || !window.firebase) throw new Error('Firebase no está configurado');
  const provider = new window.firebase.auth.GoogleAuthProvider();
  await auth.signInWithPopup(provider);
  publish();
}
export async function firebaseSignOut(): Promise<void> {
  if (auth) {
    await auth.signOut();
    publish();
  }
}
