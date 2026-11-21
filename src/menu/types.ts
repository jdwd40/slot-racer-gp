// The client shell's mode and screen names (#141, moved out of src/main.ts unchanged), shared by the hub and src/menu/*.

/** local race / practice / championship run on this device; 'online' is a server race (connected solo or multiplayer) */
export type Mode = 'race' | 'practice' | 'champ' | 'online';

export type Screen = 'title' | 'race' | 'pause' | 'results' | 'boards' | 'champ' | 'online' | 'lobby' | 'netwait' | 'netres' | 'account';
