
/// <reference types="@react-three/fiber" />
import React from 'react';
import { Grid } from '@react-three/drei';
import { COLORS } from '../../constants';
import '../../types';

interface InfiniteGridProps {
  isDarkMode?: boolean;
}

const InfiniteGrid: React.FC<InfiniteGridProps> = ({ isDarkMode }) => {
  const gridColor = isDarkMode ? COLORS.GRID_DARK : COLORS.GRID;

  return (
    <group>
      <Grid
        infiniteGrid
        followCamera

        cellSize={1.0}
        cellThickness={0.6}
        cellColor={gridColor}

        sectionSize={1.0}
        sectionThickness={0.6}
        sectionColor={gridColor}

        // Large fade so edges dissolve well before any hard cutoff
        fadeDistance={1500}
        fadeStrength={3.0}

        renderOrder={-1}
        position={[0, -0.01, 0]}
      />
    </group>
  );
};

export default InfiniteGrid;
