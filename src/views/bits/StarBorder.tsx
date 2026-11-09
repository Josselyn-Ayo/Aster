/**
 * StarBorder — componente de React Bits (https://reactbits.dev).
 * Borde animado con destellos que recorren el perímetro. CSS/Tailwind puro,
 * sin dependencias. Requiere los keyframes `star-movement-bottom` y
 * `star-movement-top` (ver tailwind.config.js).
 *
 * Adaptación local: prop `innerClassName` para ajustar el relleno al tamaño
 * del botón (el original trae `py-[16px] px-[26px]`, pensado para CTAs grandes).
 */
import type { ElementType, ComponentPropsWithoutRef, ReactNode, CSSProperties } from "react";

type StarBorderProps<T extends ElementType> = ComponentPropsWithoutRef<T> & {
  as?: T;
  className?: string;
  /** Clases del contenido interior (por defecto, las del original). */
  innerClassName?: string;
  children?: ReactNode;
  color?: string;
  speed?: CSSProperties["animationDuration"];
  thickness?: number;
  backgroundColor?: string;
  textColor?: string;
  borderColor?: string;
};

const StarBorder = <T extends ElementType = "button">({
  as,
  className = "",
  innerClassName = "border text-center text-[16px] py-[16px] px-[26px] rounded-[20px]",
  color = "white",
  speed = "6s",
  thickness = 1,
  // Vacío por defecto: el fondo lo definen las clases (el original usaba "#000000").
  backgroundColor = "",
  textColor = "#ffffff",
  borderColor = "#222222",
  children,
  ...rest
}: StarBorderProps<T>) => {
  const Component = as || "button";

  return (
    <Component
      className={`relative inline-block overflow-hidden rounded-[20px] ${className}`}
      {...(rest as object)}
      style={{
        padding: `${thickness}px 0`,
        ...((rest as { style?: CSSProperties }).style ?? {}),
      }}
    >
      <div
        className="absolute bottom-[-11px] right-[-250%] z-0 h-[50%] w-[300%] rounded-full opacity-70 animate-star-movement-bottom"
        style={{
          background: `radial-gradient(circle, ${color}, transparent 10%)`,
          animationDuration: speed,
        }}
      ></div>
      <div
        className="absolute left-[-250%] top-[-10px] z-0 h-[50%] w-[300%] rounded-full opacity-70 animate-star-movement-top"
        style={{
          background: `radial-gradient(circle, ${color}, transparent 10%)`,
          animationDuration: speed,
        }}
      ></div>
      <div
        className={`relative z-[1] ${innerClassName}`}
        // Sin backgroundColor se respeta el fondo de las clases (p. ej. degradado Tailwind).
        style={{
          ...(backgroundColor ? { background: backgroundColor } : {}),
          color: textColor,
          borderColor,
        }}
      >
        {children}
      </div>
    </Component>
  );
};

export default StarBorder;
